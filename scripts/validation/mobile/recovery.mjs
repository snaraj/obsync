// Fresh owned desktop recovery only; ordinary DOM controls, no product mutation calls.
import { readFileSync, writeFileSync, lstatSync, realpathSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { candidateCrypto } from './ciphertext-oracle.mjs';
import { connect, sleep } from './cdp.mjs';
import { recoveryManifest, validateExpectations, activeRecovery, recoveryRefusal, refusedRecovery } from './recovery-guard.mjs';
const [run, source, slot, command, kind = 'new'] = process.argv.slice(2);
if (!['B','C','D'].includes(slot) || !['open','status','stage','setup-wrong-token','setup-refuse-old','setup-refuse-wrong','make-unrelated','setup-correct','readback','quit'].includes(command) || !['old','wrong','stripped','new','unrelated'].includes(kind)) throw Error('invalid recovery operator arguments');
const state = await recoveryManifest(run,source,slot), runtime = join(state.run, 'runtime');
let c, stage=command, failureReason='owned_recovery_step_refused';
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
  if(action==='setup-correct') {
    stage='setup-active';failureReason='recovery_active_deadline_or_refusal';
    await ui(`await wait(()=>{const pin=p.state.custody2();return (${activeRecovery.toString()})({paired:p.state.paired,enrolling:p.enrolling,phase:pin?.phase,suite:pin?.suite,recoveryNotice:notice('Recovered this vault')});},'recovery did not complete',60000);return true;`);
    record({result:'PASS',recoveredExistingAccount:true,activeSuite:2,oldDeviceApprovalUsed:false});
  } else {
    stage='setup-authenticated-refusal';failureReason='expected_authenticated_refusal_absent';
    const end=Date.now()+45000;
    while(Date.now()<end&&(c.consoleSummary.reasons[refusal.reason]??0)<=baseline)await sleep(100);
    if((c.consoleSummary.reasons[refusal.reason]??0)<=baseline)throw Error('expected authenticated refusal absent');
    stage='setup-negative-after';failureReason='negative_recovery_state_or_content_changed';
    const unchanged=before===await privateFingerprint();
    const refused=await ui(`const pin=p.state.custody2();return (${refusedRecovery.toString()})({enrolling:p.enrolling,paired:p.state.paired,deviceIdAbsent:p.state.data.deviceId===null,deviceSecretAbsent:p.state.data.deviceSecret===null,phase:pin?.phase,suite:pin?.suite,purpose:p.state.stagedEnrollment2()?.purpose,engineStopped:p.engine===null||p.engine?.started===false,visibleRefusal:notice(P.text),contentAbsent:P.notes.every(n=>app.vault.getAbstractFileByPath(n.path)===null&&p.state.fileByPath(n.path)===undefined)});`,{text:refusal.notice,notes:expected.notes});
    const diskUnchanged=diskBefore===negativeDiskSnapshot(expected.notes);
    if(!unchanged||!refused||!diskUnchanged)throw Error('visible refusal or unchanged local custody absent');
    record({result:'PASS',expectedRefusal:refusal.reason,visibleRefusal:true,noCredentialAdopted:true,noActiveEnrollment:true,noContentMaterialized:true,persistedMetadataUnchanged:true,localCustodyUnchanged:true,serverAccountUnchanged:'INDEPENDENT_PARENT_READ_REQUIRED'});
  }
}
try {
  if(command==='open') {
    c=await connect(state,slot,true);
    // Same fixed owned-vault open path as existing journeys.mjs; no discovery.
    try {await c.evaluate(`require('electron').ipcRenderer.sendSync('vault-open',P.vault,false);return true;`,{},false);}catch{/* Opening can replace the owned chooser target; resulting vault is checked below. */}
    c.close();c=null;
    const until=Date.now()+45000;let trusted=false;
    while(Date.now()<until) {
      try {
        c=await connect(state,slot);
        trusted=await c.evaluate(`const bs=[...document.querySelectorAll('button')].filter(b=>b.textContent.trim()==='Trust author and enable plugins'&&!b.disabled&&b.getBoundingClientRect().width>0);if(bs.length>1)throw Error('author trust ambiguous');if(bs.length===1)bs[0].click();return !!app.plugins.plugins['obsync-private-sync']?.state;`);
        if(trusted)break;
      }catch{}
      c?.close();c=null;await sleep(200);
    }
    if(!trusted)throw Error('fresh owned vault/plugin not ready');
    await ui(`if(p.state.paired||p.state.data.deviceId!==null||p.state.data.deviceSecret!==null||p.state.custody2()!==null||p.state.data.vrk!==null)throw Error('fresh detached vault required');return true;`);
    await settings();
    await ui(`fillOwned(settingRow(pane(),'Server URL').querySelector('input'),P.url);await wait(()=>p.state.data.serverUrl===P.url,'server URL not adopted');return true;`);
    record({result:'READY',freshDetachedVault:true,usesExistingApi:true});
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
      let count=0;const labels=new Set();
      for(const note of expected.notes) {
        if(!/^[A-Za-z0-9][A-Za-z0-9 -]{0,100}\.md$/.test(note.path)||!['retained','current'].includes(note.generation)||!/^[a-f0-9]{64}$/.test(note.sha256))throw Error('bounded synthetic note expectation required');
        labels.add(note.generation);
        const path=join(state.devices[slot].vault,note.path),end=Date.now()+60000;let matches=false;
        while(Date.now()<end){if(existsSync(path)){const st=lstatSync(path);if(!st.isFile()||st.isSymbolicLink()||st.uid!==process.getuid()||st.nlink!==1||realpathSync(path)!==path)throw Error('recovered note custody');if(createHash('sha256').update(readFileSync(path)).digest('hex')===note.sha256){matches=true;break;}}await sleep(100);}
        if(!matches)throw Error('recovered disk bytes did not match');count++;
      }
      if(labels.size!==2)throw Error('retained and current generation notes both required');
      record({result:'PASS',independentlyReadRecoveredNotes:count,allRecordedSyntheticNoteHashesMatch:true});
    } else if(command==='quit') {
      await ui(`setTimeout(()=>window.electron.remote.app.quit(),0);return true;`);
      record({result:'QUIT_REQUESTED',normalOwnedAppQuit:true,fixtureRetainedForSessionTeardown:true});
    }
  }
} catch {
  record({result:'FAIL',stage,firstFailure:failureReason,detail:'Owned recovery step refused or timed out; secret-bearing details withheld. Session controllers own cleanup.'});
  process.exitCode=1;
} finally {c?.close();}
