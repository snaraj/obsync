// Fresh owned desktop recovery only; ordinary DOM controls, no product mutation calls.
import { readFileSync, writeFileSync, lstatSync, realpathSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { candidateCrypto } from './ciphertext-oracle.mjs';
import { connect, sleep, targets } from './cdp.mjs';
import { recoveryManifest, validateExpectations, activeRecovery, recoveryRefusal, refusedRecovery, recoveryRefusalFacts, visibleRecoveryRefusal, recoveryReadbackExport, recoveryChooserTarget, recoveryChooserFacts, initializedRecoveryChooser } from './recovery-guard.mjs';
const [run, source, slot, command, kind = 'new'] = process.argv.slice(2);
if (!['B','C','D'].includes(slot) || !['open','status','stage','setup-wrong-token','setup-refuse-old','setup-refuse-wrong','make-unrelated','setup-correct','readback','quit'].includes(command) || !['old','wrong','stripped','new','unrelated'].includes(kind)) throw Error('invalid recovery operator arguments');
const state = await recoveryManifest(run,source,slot), runtime = join(state.run, 'runtime');
let c, stage=command, failureReason='owned_recovery_step_refused',negativeReadiness,openReadiness,openDeadlineTimer,openStartedAt;
function privateRead(name) {
  const path=join(runtime,name),st=lstatSync(path);
  if (!st.isFile()||st.isSymbolicLink()||st.uid!==process.getuid()||(st.mode&0o077)||st.nlink!==1||realpathSync(path)!==path) throw Error('private input custody');
  return readFileSync(path,'utf8').trim();
}
function record(value) {
  const receipt={schema:1,at:new Date().toISOString(),sourceHead:state.source_head,slot,command,...value};
  writeFileSync(join(state.run,'evidence',`mobile-recovery-${slot}-${command}-${Date.now()}.json`),JSON.stringify(receipt,null,2)+'\n',{mode:0o600,flag:'wx'});
  console.log(JSON.stringify(receipt));
}
const dom=`
 const p=app.plugins.plugins['obsync-private-sync'];if(!p?.state||p.manifest.version!==P.version)throw Error('owned candidate/API required');
 const visible=e=>!!e&&e.getBoundingClientRect().width>0&&e.getBoundingClientRect().height>0;
 // Query the live owned settings document while preserving main-vault checks.
 const documents=()=>[...new Set([document,app.setting.modalEl?.isConnected?app.setting.modalEl.ownerDocument:null].filter(d=>d&&!d.defaultView?.closed))];
 const ownedElements=selector=>documents().flatMap(d=>[...d.querySelectorAll(selector)]);
 const dialogs=()=>ownedElements('.modal:not(.mod-settings)').filter(visible);
 const pane=()=>{const ps=ownedElements('.mod-settings .vertical-tab-content').filter(visible);if(ps.length>1)throw Error('settings pane ambiguous');return ps[0]??null;};
 const fillOwned=(input,value)=>{if(!input)throw Error('missing owned input');input.value=value;const Event=input.ownerDocument.defaultView.Event;input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}));};
 const settingRow=(root,name)=>{const rs=[...root.querySelectorAll('.setting-item')].filter(r=>r.querySelector('.setting-item-name')?.textContent.trim()===name);if(rs.length!==1)throw Error('row identity');return rs[0];};
 const press=(root,text)=>{const bs=[...root.querySelectorAll('button')].filter(b=>b.textContent.trim()===text&&!b.disabled&&visible(b));if(bs.length!==1)throw Error('button identity');bs[0].scrollIntoView({block:'center'});bs[0].click();};
 const notice=text=>ownedElements('.notice').some(n=>visible(n)&&n.textContent.includes(text));
`;
async function ui(body,params={}) {return c.evaluate(dom+body,{...params,version:state.pluginVersion});}
async function settings() {await ui(`if(dialogs().length)throw Error('unexpected dialog');app.setting.open();app.setting.openTabById('obsync-private-sync');await wait(()=>pane()&&[...pane().querySelectorAll('.setting-item-name')].some(e=>e.textContent.trim()==='Recovery backup'),'settings');return true;`);}
async function privateFingerprint() {return ui(`const bytes=new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify([p.state.data.deviceId,p.state.data.deviceSecret,p.state.data.vrk,p.state.custody2()]))));return [...bytes].map(b=>b.toString(16).padStart(2,'0')).join('');`);}
function negativeDiskSnapshot(notes) {
  const metadata=join(state.devices[slot].vault,'.obsidian/plugins/obsync-private-sync/data.json'),info=lstatSync(metadata);
  if(!info.isFile()||info.isSymbolicLink()||info.uid!==process.getuid()||info.nlink!==1||realpathSync(metadata)!==metadata)throw Error('owned recovery metadata required');
  if(notes.some(note=>existsSync(join(state.devices[slot].vault,note.path))))throw Error('unexpected recovered disk content');
  return createHash('sha256').update(readFileSync(metadata)).digest('hex');
}
async function setup(action) {
  stage='setup-settings';failureReason='owned_recovery_settings_refused';
  await settings();
  stage='setup-token';failureReason='owned_setup_token_refused';
  let token=privateRead('server/journal/v1/setup-token');if(!/^[a-f0-9]{64}$/.test(token))throw Error('owned token shape');
  if(action==='setup-wrong-token')token=(token[0]==='0'?'1':'0')+token.slice(1);
  const negative=action!=='setup-correct',expected=negative?JSON.parse(privateRead('../private/recovery-expectations.json')):null;
  stage='setup-negative-before';failureReason='negative_recovery_baseline_refused';
  if(negative)validateExpectations(expected,state.source_head);
  const before=await privateFingerprint(),diskBefore=negative?negativeDiskSnapshot(expected.notes):null;
  const refusal=negative?recoveryRefusal(action):null,baseline=negative?(c.consoleSummary.reasons[refusal.reason]??0):0;
  stage='setup-submit';failureReason='ordinary_recovery_submit_refused';
  await ui(`const staged=p.state.stagedEnrollment2();if(p.state.paired||p.state.data.deviceId!==null||staged?.purpose!=='recover')throw Error('staged recovery without credential required');fillOwned(settingRow(pane(),'Setup or recover').querySelector('input'),P.token);press(settingRow(pane(),'Setup or recover'),'Set up or recover');return true;`,{token});
  const closeStatus=async remaining=>{
    await ui(`const ds=dialogs();if(ds.length!==1||ds[0].querySelector('.modal-title')?.textContent.trim()!=='Recent sync activity')throw Error('owned recovery status identity');const bg=ds[0].parentElement?.querySelector(':scope > .modal-bg');if(!bg||!visible(bg))throw Error('owned recovery status background absent');bg.click();await wait(()=>dialogs().length===0,'owned recovery status closed',P.remaining);return true;`,{remaining:remaining()});remaining();
  };
  if(action==='setup-correct') {
    stage='setup-active';failureReason='recovery_active_deadline_or_refusal';
    const started=performance.now(),remaining=()=>{const ms=60000-(performance.now()-started);if(ms<=0)throw Error('active recovery observation deadline');return ms;};
    // Custody readiness precedes opening Recent; final success still requires its rendered confirmation.
    await ui(`await wait(()=>{const pin=p.state.custody2();return (${activeRecovery.toString()})({paired:p.state.paired,enrolling:p.enrolling,phase:pin?.phase,suite:pin?.suite,recoveryNotice:true});},'recovery did not complete',P.remaining);return true;`,{remaining:remaining()});remaining();
    await ui(`if(dialogs().length)throw Error('unexpected recovery dialog');app.setting.close();if(app.commands.executeCommandById('obsync-private-sync:recent')===false)throw Error('ordinary recovery status command absent');await wait(()=>{const pin=p.state.custody2();return (${activeRecovery.toString()})({paired:p.state.paired,enrolling:p.enrolling,phase:pin?.phase,suite:pin?.suite,recoveryNotice:(${visibleRecoveryRefusal.toString()})(dialogs(),P.text,visible)});},'visible recovered enrollment in Recent',P.remaining);return true;`,{text:"Recovered this vault's enrollment. Starting encrypted sync.",remaining:remaining()});remaining();
    await closeStatus(remaining);
    record({result:'PASS',recoveredExistingAccount:true,activeSuite:2,oldDeviceApprovalUsed:false,visibleRecoveryNoticeSource:'RECENT_UI',activeReadiness:{budgetMs:60000,elapsedMs:60000-remaining()}});
  } else {
    stage='setup-authenticated-refusal';failureReason='expected_authenticated_refusal_absent';
    const started=performance.now(),end=started+45000;
    const remaining=()=>{const ms=end-performance.now();if(ms<=0)throw Error('negative recovery observation deadline');return ms;};
    while(performance.now()<end&&(c.consoleSummary.reasons[refusal.reason]??0)<=baseline)await sleep(Math.min(100,remaining()));
    if((c.consoleSummary.reasons[refusal.reason]??0)<=baseline)throw Error('expected authenticated refusal absent');
    stage='setup-negative-after';failureReason='negative_recovery_state_or_content_changed';
    const sample=recent=>ui(`const pin=p.state.custody2();const value={enrolling:p.enrolling,paired:p.state.paired,deviceIdAbsent:p.state.data.deviceId===null,deviceSecretAbsent:p.state.data.deviceSecret===null,phase:pin?.phase,suite:pin?.suite,purpose:p.state.stagedEnrollment2()?.purpose,engineStopped:p.engine===null||p.engine?.started===false,visibleRefusal:P.recent?(${visibleRecoveryRefusal.toString()})(dialogs(),P.text,visible):notice(P.text),contentAbsent:P.notes.every(n=>app.vault.getAbstractFileByPath(n.path)===null&&p.state.fileByPath(n.path)===undefined)};return {refused:(${refusedRecovery.toString()})(value),facts:(${recoveryRefusalFacts.toString()})(value)};`,{text:refusal.notice,notes:expected.notes,recent});
    const initial=await sample(false),unchanged=before===await privateFingerprint(),diskUnchanged=diskBefore===negativeDiskSnapshot(expected.notes);
    negativeReadiness={budgetMs:45000,elapsedMs:performance.now()-started,expectedReasonObserved:true,initial:{...initial.facts,localCustodyUnchanged:unchanged,persistedMetadataUnchanged:diskUnchanged}};
    if(!unchanged||!diskUnchanged||Object.entries(initial.facts).some(([key,value])=>key!=='visibleRefusal'&&value!==true))throw Error('visible refusal or unchanged local custody absent');
    stage='setup-visible-Recent';failureReason='negative_recovery_visible_recent_absent';remaining();
    try{await ui(`if(dialogs().length)throw Error('unexpected recovery dialog');app.setting.close();if(app.commands.executeCommandById('obsync-private-sync:recent')===false)throw Error('ordinary recovery status command absent');await wait(()=>(${visibleRecoveryRefusal.toString()})(dialogs(),P.text,visible),'visible recovery Recent refusal',P.remaining);return true;`,{text:refusal.notice,remaining:remaining()});remaining();}finally{negativeReadiness.elapsedMs=performance.now()-started;}
    stage='setup-negative-after';failureReason='negative_recovery_state_or_content_changed';
    const after=await sample(true),finalUnchanged=before===await privateFingerprint(),finalDiskUnchanged=diskBefore===negativeDiskSnapshot(expected.notes);
    negativeReadiness.after={...after.facts,localCustodyUnchanged:finalUnchanged,persistedMetadataUnchanged:finalDiskUnchanged};negativeReadiness.elapsedMs=45000-remaining();
    if(!finalUnchanged||!after.refused||!finalDiskUnchanged)throw Error('visible refusal or unchanged local custody absent');
    stage='setup-close-owned-status';failureReason='owned_recovery_status_close_refused';
    await closeStatus(remaining);negativeReadiness.elapsedMs=45000-remaining();
    record({result:'PASS',expectedRefusal:refusal.reason,visibleRefusal:true,visibleRefusalSource:'RECENT_UI',negativeReadiness,noCredentialAdopted:true,noActiveEnrollment:true,noContentMaterialized:true,persistedMetadataUnchanged:true,localCustodyUnchanged:true,serverAccountUnchanged:'INDEPENDENT_PARENT_READ_REQUIRED'});
  }
}
// Closed failure-only startup facts; no exception text, paths or DOM content.
function openErrorClass(error) {
  try {
    if(error?.name==='TimeoutError'||error?.name==='AbortError')return 'HTTP_TIMEOUT';
    const codes={'device process identity changed':'PROCESS_IDENTITY','unowned device':'OWNERSHIP',
      'recorded vault has no main window':'BOUND_VAULT_ABSENT','lab window not ready':'PAGE_ABSENT',
      'foreign CDP address':'FOREIGN_CDP','CDP connection failed':'CDP_CONNECT','CDP disconnected':'CDP_DISCONNECTED',
      'CDP deadline':'CDP_DEADLINE','lab UI step refused or timed out; no secret-bearing exception printed':'UI_EVALUATION',
      'fresh owned vault/plugin not ready':'PLUGIN_NOT_READY','fresh owned recovery open deadline':'OPEN_DEADLINE',
      'chooser target observation invalid':'CHOOSER_OBSERVATION','chooser target ambiguous':'CHOOSER_AMBIGUOUS',
      'chooser target identity':'CHOOSER_IDENTITY','chooser renderer observation invalid':'CHOOSER_OBSERVATION',
      'chooser renderer identity':'CHOOSER_IDENTITY','chooser identity changed before dispatch':'CHOOSER_IDENTITY'};
    return Object.hasOwn(codes,error?.message)?codes[error.message]:'UNKNOWN';
  }catch{return 'UNKNOWN';}
}
function observeOpenError(facts,stage,error) {
  const value={stage,errorClass:openErrorClass(error)};
  facts.errorCount++;facts.errors[value.errorClass]=(facts.errors[value.errorClass]??0)+1;
  facts.firstError??=value;facts.lastError=value;
}
try {
  if(command==='open') {
    openReadiness={budgetMs:45000,pollMs:200,initialDispatch:'NOT_STARTED',polls:0,boundVaultObservations:0,trustChoiceObservations:0,trustClickObservations:0,pluginReadyObserved:false,detachedCheckCompleted:false,settingsCheckCompleted:false,serverUrlCheckCompleted:false,errorCount:0,errors:{},firstError:null,lastError:null};
    openStartedAt=performance.now();const until=openStartedAt+45000;
    const remaining=()=>{const ms=until-performance.now();if(ms<=0)throw Error('fresh owned recovery open deadline');return ms;};
    // Opening admission budget; not whole-CLI wall time or cancellation of guest evaluation.
    openDeadlineTimer=setTimeout(()=>{
      try{stage='open-deadline';openReadiness.elapsedMs=Math.max(0,performance.now()-openStartedAt);observeOpenError(openReadiness,stage,Error('fresh owned recovery open deadline'));
        record({result:'FAIL',stage,firstFailure:failureReason,openReadiness,detail:'Owned recovery open deadline; guest evaluation cancellation is not asserted.'});}
      finally{try{c?.close();}finally{process.exit(1);}}
    },45000);
    openReadiness.chooserPolls=0;openReadiness.initializedChooserObserved=false;openReadiness.dispatchAttempts=0;
    stage='open-chooser-readiness';
    while(true) {
      remaining();openReadiness.chooserPolls++;
      const target=recoveryChooserTarget(await targets(state,slot));remaining();
      if(target) {
        c=await connect(state,slot,true,target.id);remaining();
        const facts=await c.evaluate(`return (${recoveryChooserFacts.toString()})();`,{},false);remaining();
        const ready=initializedRecoveryChooser(facts);
        if(!facts.exactUrl)throw Error('chooser renderer identity');
        openReadiness.lastChooser=facts;
        if(ready){openReadiness.initializedChooserObserved=true;openReadiness.chooserTargetIdSha256=createHash('sha256').update(target.id).digest('hex');break;}
        c.close();c=null;
      }
      await sleep(Math.min(200,remaining()));
    }
    // Exactly one existing vault-open call, in the admitted initialized chooser.
    stage='open-vault-dispatch';remaining();openReadiness.initialDispatch='STARTED';openReadiness.dispatchAttempts++;
    let dispatchReturned=false,dispatchResult;
    try {dispatchResult=await c.evaluate(`if(!(${initializedRecoveryChooser.toString()})((${recoveryChooserFacts.toString()})()))return false;require('electron').ipcRenderer.sendSync('vault-open',P.vault,false);return true;`,{},false);dispatchReturned=true;openReadiness.initialDispatch='COMPLETED';}catch(error){openReadiness.initialDispatch='REFUSED_OR_TARGET_REPLACED';observeOpenError(openReadiness,stage,error);/* Preserve existing navigation/target-replacement handling; never redispatch. */}
    remaining();if(dispatchReturned&&dispatchResult!==true)throw Error('chooser identity changed before dispatch');
    c.close();c=null;
    let trusted=false;
    while(performance.now()<until) {
      openReadiness.polls++;stage='open-bound-vault-observation';
      try {
        c=await connect(state,slot);remaining();openReadiness.boundVaultObservations++;stage='open-trust-plugin-observation';
        const observation=await c.evaluate(`const bs=[...document.querySelectorAll('button')].filter(b=>b.textContent.trim()==='Trust author and enable plugins'&&!b.disabled&&b.getBoundingClientRect().width>0);if(bs.length>1)throw Error('author trust ambiguous');if(bs.length===1)bs[0].click();return {pluginReady:!!app.plugins.plugins['obsync-private-sync']?.state,trustChoiceObserved:bs.length===1,trustClickObserved:bs.length===1};`);
        remaining();trusted=observation.pluginReady;openReadiness.pluginReadyObserved||=trusted;
        if(observation.trustChoiceObserved)openReadiness.trustChoiceObservations++;
        if(observation.trustClickObserved)openReadiness.trustClickObservations++;
        if(trusted)break;
      }catch(error){observeOpenError(openReadiness,stage,error);}
      remaining();c?.close();c=null;await sleep(Math.min(200,remaining()));
    }
    remaining();stage='open-plugin-readiness';
    if(!trusted)throw Error('fresh owned vault/plugin not ready');
    stage='open-detached-state';
    await ui(`if(p.state.paired||p.state.data.deviceId!==null||p.state.data.deviceSecret!==null||p.state.custody2()!==null||p.state.data.vrk!==null)throw Error('fresh detached vault required');return true;`);
    remaining();openReadiness.detachedCheckCompleted=true;stage='open-settings';
    await settings();remaining();openReadiness.settingsCheckCompleted=true;stage='open-server-url';
    await ui(`fillOwned(settingRow(pane(),'Server URL').querySelector('input'),P.url);await wait(()=>p.state.data.serverUrl===P.url,'server URL not adopted');return true;`);
    openReadiness.elapsedMs=45000-remaining();openReadiness.serverUrlCheckCompleted=true;
    record({result:'READY',freshDetachedVault:true,usesExistingApi:true,openReadiness});remaining(); // Synchronous receipt/console I/O cannot turn an over-budget CLI into success.
  } else {
    c=await connect(state,slot);
    await ui(`if(p.state.data.serverUrl!==P.url)throw Error('owned API endpoint changed');return true;`);
    if(command==='status')record(await ui(`const pin=p.state.custody2();return {result:'OBSERVED',paired:p.state.paired,phase:pin?.phase??null,suite:pin?.suite??null,credentialAdopted:p.state.data.deviceId!==null,status:p.currentStatus().kind,dialogCount:dialogs().length};`));
    else if(command==='make-unrelated') {
      if(slot!=='D')throw Error('fresh unrelated backup requires fixed D fixture');
      const api=candidateCrypto(source,state.source_head,state.artifacts['plugin/main.js']),root=randomBytes(32);
      const old=await api.backup.parseRecoveryBackup(privateRead('../private/desktop/phone-old-recovery-backup.txt'));
      const current=await api.backup.parseRecoveryBackup(privateRead('../private/desktop/phone-new-recovery-backup.txt'));
      if(Buffer.from(root).equals(Buffer.from(old))||Buffer.from(root).equals(Buffer.from(current)))throw Error('independent unrelated root required');
      const backup=await api.backup.encodeRecoveryBackup(root),decoded=await api.backup.parseRecoveryBackup(backup);
      if(!Buffer.from(decoded).equals(root))throw Error('candidate codec roundtrip failed');
      const path=join(state.run,'private/desktop/phone-unrelated-recovery-backup.txt');
      writeFileSync(path,backup+'\n',{mode:0o600,flag:'wx'});
      if(privateRead('../private/desktop/phone-unrelated-recovery-backup.txt')!==backup)throw Error('private unrelated backup readback failed');
      record({result:'PASS',candidateCodecBound:true,decoderHash:api.decoderHash,validCompleteUnrelatedBackup:true,independentRandomRoot:true,privateBackupReadback:true,productStateMutated:false});
    } else if(command==='stage') {
      const newBackup=privateRead('../private/desktop/phone-new-recovery-backup.txt');if(!/^obsync-recovery-v2(?: [a-z]+){24}$/.test(newBackup))throw Error('complete owned new backup required');
      let backup=kind==='old'?privateRead('../private/desktop/phone-old-recovery-backup.txt'):kind==='unrelated'?privateRead('../private/desktop/phone-unrelated-recovery-backup.txt'):newBackup;
      if(kind==='unrelated'&&(slot!=='D'||backup===newBackup||backup===privateRead('../private/desktop/phone-old-recovery-backup.txt')))throw Error('distinct fixed-D backup required');
      if(kind==='old'&&backup===newBackup)throw Error('rotation must have changed backup');
      if(kind==='stripped')backup=backup.replace(/^obsync-recovery-v2 /,'');
      if(kind==='wrong'){const words=backup.split(' ');words[1]='notaword';backup=words.join(' ');}
      await settings();const before=await privateFingerprint();
      await ui(`if(p.state.paired||p.state.data.deviceId!==null||p.state.custody2()!==null)throw Error('fresh unstaged vault required');press(settingRow(pane(),'Recovery backup'),'Restore or create');await wait(()=>dialogs().length===1&&dialogs()[0].querySelector('.modal-title')?.textContent==='Vault recovery','recovery dialog');const m=dialogs()[0];fillOwned(settingRow(m,'Recovery backup').querySelector('textarea'),P.backup);press(m,'Stage current backup');return true;`,{backup});
      if(kind==='stripped'||kind==='wrong') {
        await ui(`await wait(()=>notice(P.code),'explicit backup refusal');if(p.state.paired||p.state.data.deviceId!==null||p.state.custody2()!==null)throw Error('invalid backup changed custody');return true;`,{code:kind==='stripped'?'backup_format':'backup_phrase'});
        if(before!==await privateFingerprint())throw Error('refused staging changed local custody');
        await ui(`const ds=dialogs();if(ds.length!==1||ds[0].querySelector('.modal-title')?.textContent!=='Vault recovery')throw Error('owned recovery close identity');const bg=ds[0].parentElement?.querySelector(':scope > .modal-bg');if(!bg||!visible(bg))throw Error('owned recovery background unavailable');bg.click();return true;`);
        await ui(`await wait(()=>dialogs().length===0,'recovery dialog closure');return true;`);
        record({result:'PASS',backupCase:kind,explicitLocalRefusal:true,localCustodyUnchanged:true,networkRecoveryAttempted:false});
      } else {
        await ui(`await wait(()=>dialogs().length===0&&p.state.stagedEnrollment2()?.purpose==='recover'&&p.state.custody2()?.phase==='enrollment','recovery staging');return true;`);
        writeFileSync(join(runtime,`mobile-recovery-${slot}-staged-case.json`),JSON.stringify({kind})+'\n',{mode:0o600,flag:'wx'});
        record({result:'STAGED',backupCase:kind,suite:2,credentialAdopted:false});
      }
    } else if(command.startsWith('setup-')) {
      const staged=JSON.parse(privateRead(`mobile-recovery-${slot}-staged-case.json`));
      const expected=command==='setup-refuse-old'?'old':command==='setup-refuse-wrong'?'unrelated':'new';if(staged.kind!==expected)throw Error('wrong staged recovery case');
      await setup(command);
    } else if(command==='readback') {
      await ui(`if(!p.state.paired||p.state.custody2()?.phase!=='active')throw Error('active recovered vault required');return true;`);
      const expected=JSON.parse(privateRead('../private/recovery-expectations.json'));
      validateExpectations(expected,state.source_head);
      await ui(`const pin=p.state.custody2();const hash=[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(pin?.generation??'')))].map(n=>n.toString(16).padStart(2,'0')).join('');if(pin?.suite!==2||hash!==P.generationHash)throw Error('wrong recovered generation');return true;`,{generationHash:expected.generationHash});
      if(slot!=='C')throw Error('fixed fresh C recovery readback required');
      const exported=recoveryReadbackExport(state.run,state.source_head,expected);let complete=false,count=0;
      try{
        const labels=new Set();
        for(const [index,note] of expected.notes.entries()) {
          if(!/^[A-Za-z0-9][A-Za-z0-9 -]{0,100}\.md$/.test(note.path)||!['retained','current'].includes(note.generation)||!/^[a-f0-9]{64}$/.test(note.sha256))throw Error('bounded synthetic note expectation required');
          labels.add(note.generation);
          const path=join(state.devices[slot].vault,note.path),end=Date.now()+60000;let matches=false;
          while(Date.now()<end){if(existsSync(path)){const st=lstatSync(path);if(!st.isFile()||st.isSymbolicLink()||st.uid!==process.getuid()||st.nlink!==1||realpathSync(path)!==path)throw Error('recovered note custody');const bytes=readFileSync(path);matches=exported.observe(index,bytes);if(matches)break;}await sleep(100);}
          if(!matches)throw Error('recovered disk bytes did not match');count++;
        }
        if(labels.size!==2)throw Error('retained and current generation notes both required');complete=true;
      }finally{exported.finish(complete);}
      record({result:'PASS',independentlyReadRecoveredNotes:count,allRecordedSyntheticNoteHashesMatch:true,retainedByteEvidence:'evidence/recovery-C-readback/result.json'});
    } else if(command==='quit') {
      await ui(`setTimeout(()=>window.electron.remote.app.quit(),0);return true;`);
      record({result:'QUIT_REQUESTED',normalOwnedAppQuit:true,fixtureRetainedForSessionTeardown:true});
    }
  }
} catch(error) {
  if(openReadiness){openReadiness.elapsedMs=Math.max(0,performance.now()-openStartedAt);observeOpenError(openReadiness,stage,error);}
  record({result:'FAIL',stage,firstFailure:failureReason,negativeReadiness,openReadiness,detail:'Owned recovery step refused or timed out; secret-bearing details withheld. Session controllers own cleanup.'});
  process.exitCode=1;
} finally {clearTimeout(openDeadlineTimer);c?.close();}
