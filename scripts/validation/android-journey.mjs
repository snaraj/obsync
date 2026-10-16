// One owned Android session. Ordinary UI actions; independent persisted-byte reads.
import { readFileSync, writeFileSync, lstatSync, realpathSync, existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { scriptJson } from './mobile/cdp.mjs';

export const digest = bytes => createHash('sha256').update(bytes).digest('hex');
export function androidPathArg(value){if(!/^[A-Za-z0-9/ ._()-]+$/.test(value))throw Error('bounded Android path required');return "'"+value+"'";}
export function androidExecPathArg(value){androidPathArg(value);return value;}
export function candidateControlRead(labelMatches){const visible=e=>!!e&&e.getBoundingClientRect().width>0&&e.getBoundingClientRect().height>0;const manifest=app.plugins?.manifests?.['obsync-private-sync'];const activeTabIdMatches=app.setting?.activeTab?.id==='community-plugins',navTabActive=[...document.querySelectorAll('.vertical-tab-nav-item.is-active')].filter(visible).some(e=>e.textContent.trim()==='Community plugins');const rows=manifest?[...document.querySelectorAll('.setting-item')].filter(visible).filter(e=>e.querySelector('.setting-item-name')?.textContent.includes(manifest.name)):[];const versions=manifest?rows.filter(e=>labelMatches(manifest.name,manifest.version,e.textContent)):[];const toggles=versions.length===1?[...versions[0].querySelectorAll('.checkbox-container')].filter(visible):[];const facts={manifestPresent:!!manifest,activeTabIdMatches,navTabActive,officialTabActive:activeTabIdMatches||navTabActive,nameRows:rows.length,versionRows:versions.length,toggleCount:toggles.length,toggleEnabled:!!toggles[0]?.classList.contains('is-enabled'),candidateAlreadyLoaded:!!app.plugins?.plugins?.['obsync-private-sync']};const refused=facts.nameRows>1||facts.versionRows>1||facts.toggleCount>1||facts.candidateAlreadyLoaded||facts.toggleEnabled;return {facts,toggle:toggles[0],refused,ready:!refused&&facts.officialTabActive&&facts.nameRows===1&&facts.versionRows===1&&facts.toggleCount===1};}
export async function waitCandidateReadiness(read,pause=ms=>new Promise(r=>setTimeout(r,ms)),now=Date.now,budget=20000){
  const first=read(),started=now(),end=started+budget;let current=first,polls=1;while(!current.ready&&!current.refused&&now()<end){await pause(Math.min(100,end-now()));current=read();polls++;}return {before:first.facts,after:current.facts,polls,ready:current.ready,deadlineMs:budget,elapsedMs:now()-started};
}
export async function waitScopeSave(read,pause=ms=>new Promise(r=>setTimeout(r,ms)),now=Date.now,budget=30000,deadline){
  const started=now(),end=deadline??started+budget;let before,after,polls=0,ready=false;while(now()<end){after=await read(Math.min(5000,end-now()));before??=after;polls++;ready=now()<=end&&after.changingScope===false&&after.policyMatches===true;if(ready)break;if(now()<end)await pause(Math.min(100,end-now()));}return {before,after,polls,ready,deadlineMs:budget,elapsedMs:now()-started};
}
export function scopeSaveObservation(app,document,folders){
  const visible=e=>!!e&&e.getClientRects().length>0,p=app.plugins.plugins['obsync-private-sync'];
  const rows=[...document.querySelectorAll('.setting-item')].filter(visible).filter(r=>r.querySelector('.setting-item-name')?.textContent.trim()==='Selected folders');
  const input=rows.length===1?rows[0].querySelector('textarea'):null;
  const confirmation=[...document.querySelectorAll('.modal:not(.mod-settings)')].filter(visible).some(m=>['Cancel','Save anyway'].every(label=>[...m.querySelectorAll('button')].filter(visible).some(b=>b.textContent.trim()===label)));
  const refused="That selection cannot be saved: each line must be a folder inside this vault, such as Notes or Projects/2026. Folders whose names start with a dot are hidden and never synced.";
  return {changingScope:p.changingScope===true,policyMatches:JSON.stringify(p.state.data.syncFolders)===JSON.stringify(folders),exactFolderPresent:folders.every(path=>Array.isArray(app.vault.getAbstractFileByPath(path)?.children)),renderedDraftMatches:!!input&&input.value===folders.join('\n'),knownConfirmationModalVisible:confirmation,knownRefusalVisible:[...document.querySelectorAll('.notice')].filter(visible).some(n=>n.textContent.trim()===refused)};
}
export async function waitFolderIndex(app,folder,pause=ms=>new Promise(r=>setTimeout(r,ms)),now=Date.now){
  const started=now(),end=started+10000;let first=null,last=null,polls=0;
  const result=(ready,rows,boundExceeded=false)=>({ready,rows,first,last,polls,elapsedMs:now()-started,deadlineMs:10000,boundExceeded});
  while(now()<end){
    const f=app.vault.getAbstractFileByPath(folder);let rows;
    const facts={folderPresent:!!f,childrenArray:Array.isArray(f?.children),descendantCount:null,missingOrInvalidIdentityCount:null};
    if(f&&Array.isArray(f.children)){
      const files=app.vault.getMarkdownFiles().filter(f=>f.path.startsWith(folder+'/'));
      facts.descendantCount=Math.min(files.length,33);
      if(files.length>32){first??=facts;last=facts;polls++;return result(false,undefined,true);}
      rows=files.map(f=>({path:f.path,id:app.plugins.plugins['obsync-private-sync'].state.fileByPath(f.path)?.fileId??null}));
      facts.missingOrInvalidIdentityCount=rows.filter(r=>!/^[a-f0-9]{32}$/.test(r.id??'')).length;
    }
    first??=facts;last=facts;polls++;
    if(rows&&rows.every(r=>/^[a-f0-9]{32}$/.test(r.id??'')))return result(true,rows);
    await pause(100);
  }
  return result(false);
}
export function noteIndexObservation(app,note,expectIdentity){
  const p=app.plugins?.plugins?.['obsync-private-sync'],pin=p?.state?.custody2(),paired=p?.state?.paired,r=p?.state?.fileByPath(note);
  return {nativeNotePresent:!!app.vault.getFileByPath(note),identityPresent:r!==undefined&&r!==null,fileIdValid:/^[a-f0-9]{32}$/.test(r?.fileId??''),
    stateValid:!!p?.state&&!p.waiting&&(paired===true?pin?.suite===2&&pin.phase==='active':expectIdentity===false&&paired===false&&pin===null)};
}
export async function waitNoteReadiness(read,facts,expectIdentity,pause=ms=>new Promise(r=>setTimeout(r,ms)),now=Date.now,end=now()+15000){
  const started=now();facts.polls=0;facts.ready=false;facts.refused=false;
  while(now()<end){facts.polls++;const value=await read(Math.min(5000,end-now()));const observed={};for(const key of ['exactBytesMatched','nativeNotePresent','identityPresent','fileIdValid','stateValid'])observed[key]=typeof value[key]==='boolean'?value[key]:null;facts.before??=observed;facts.after=observed;facts.elapsedMs=now()-started;
    facts.refused=Object.values(observed).some(v=>typeof v!=='boolean')||observed.stateValid!==true||observed.identityPresent&&observed.fileIdValid!==true;
    if(facts.refused)break;
    facts.ready=now()<=end&&observed.exactBytesMatched&&observed.nativeNotePresent&&(!expectIdentity||observed.fileIdValid);
    if(facts.ready)break;if(now()<end)await pause(Math.min(100,end-now()));}
  facts.elapsedMs=now()-started;return facts;
}
export async function waitKnownNotesIndex(read,expectedRows,pause=ms=>new Promise(r=>setTimeout(r,ms)),now=Date.now,budget=20000){
  if(!Array.isArray(expectedRows)||!expectedRows.length||expectedRows.length>32)throw Error('known-note proof rows invalid');
  const expected=new Map();for(const row of expectedRows){if(typeof row.path!=='string'||expected.has(row.path)||!/^[a-f0-9]{64}$/.test(row.fileIdHash??''))throw Error('known-note proof rows invalid');expected.set(row.path,row.fileIdHash);}
  const started=now(),end=started+budget;let firstPaths,before,after,files,polls=0,ready=false;
  while(now()<end){const snapshot=await read(Math.min(5000,end-now()));polls++;const rows=snapshot.rows,paths=rows.map(r=>r.path).sort();const present=new Set(paths);if(present.size!==paths.length||firstPaths&&firstPaths.some(path=>!present.has(path)))throw Error('known note local inventory changed during readiness');firstPaths??=paths;
    if(rows.some(r=>!expected.has(r.path)||r.fileIdHash!==null&&r.fileIdHash!==expected.get(r.path)))throw Error('local notes not independently known before pairing');
    after={localNoteCount:rows.length,missingIdentityCount:rows.filter(r=>r.fileIdHash===null).length,statusKind:snapshot.statusKind,waitingHandlePresent:snapshot.waitingHandlePresent};before??=after;ready=now()<=end&&after.missingIdentityCount===0;if(ready){files=rows;break;}if(now()<end)await pause(Math.min(100,end-now()));}
  return {files,readiness:{before,after,polls,ready,deadlineMs:budget,elapsedMs:now()-started}};
}
export async function waitPairingActivation(read,pause=ms=>new Promise(r=>setTimeout(r,ms)),now=Date.now,budget=45000){
  const started=now(),end=started+budget;let before,after,polls=0,ready=false,refused=false;const transitions=[];
  while(now()<end){after=await read(Math.min(5000,end-now()));polls++;before??=after;if(!transitions.length||JSON.stringify(transitions.at(-1))!==JSON.stringify(after)){if(transitions.length===16)transitions.splice(1,1);transitions.push(after);}refused=after.paired&&after.phase==='active'&&after.generationMatched===false;ready=now()<=end&&after.paired&&after.suite===2&&after.phase==='active'&&after.generationMatched===true&&after.consentVisibleCount===0;if(ready||refused)break;if(now()<end)await pause(Math.min(100,end-now()));}
  return {ready,refused,before,after,polls,transitions,deadlineMs:budget,elapsedMs:now()-started};
}
export async function pairingSnapshot(expected,comparisons){
  const p=window.app.plugins.plugins['obsync-private-sync'],pin=p.state.custody2(),visible=e=>e.getBoundingClientRect().width>0&&e.getBoundingClientRect().height>0,modals=[...document.querySelectorAll('.modal:not(.mod-settings)')].filter(visible),title=m=>m.querySelector('.modal-title')?.textContent.trim(),consent=modals.filter(m=>title(m)==="Add this vault's notes to the server's vault?"),claimants=modals.filter(m=>title(m)==='Pair this device'),last=claimants[0]?.querySelector('p:last-child')?.textContent??'',shown=comparisons();
  const hash=async s=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(s)))).map(v=>v.toString(16).padStart(2,'0')).join(''),kind=p.currentStatus().kind;
  return {paired:p.state.paired,suite:pin?.suite??null,phase:pin?.phase??null,generationMatched:pin?.phase==='active'&&pin.suite===2?await hash(pin.generation)===expected:null,consentVisibleCount:consent.length,claimantVisibleCount:claimants.length,comparisonVisibleCount:shown.claimant.length,waitingHandlePresent:!!p.waiting,statusKind:/^[a-z][a-z_-]{0,23}$/.test(kind)?kind:'OTHER',claimantUiStatus:last==='Claiming the pairing…'?'CLAIMING':last.startsWith('Waiting for approval')?'WAITING_APPROVAL':last.startsWith('Approved. Comparing')?'APPROVED_COMPARING':last?'OTHER_STATUS':'NONE'};
}
// Read-only terminal facts; no key, credential, invitation, code or free UI text.
export async function rotationPairObservation(app, expected) {
  const p=app?.plugins?.plugins?.['obsync-private-sync'],c=p?.state?.custody2();
  const hash=async value=>typeof value==='string'?[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value)))].map(b=>b.toString(16).padStart(2,'0')).join(''):null;
  const visible=e=>e.getBoundingClientRect().width>0&&e.getBoundingClientRect().height>0,modals=[...document.querySelectorAll('.modal:not(.mod-settings)')].filter(visible),titles=modals.map(m=>m.querySelector('.modal-title')?.textContent.trim());
  const current=await hash(c?.generation),old=await hash(c?.history?.generation);
  return {statePresent:!!p?.state,paired:p?.state?.paired===true,suite2:c?.suite===2,phase:['active','enrollment','draft','prepared','commit_unknown'].includes(c?.phase)?c.phase:c==null?'NONE':'OTHER',generationValid:/^[a-f0-9]{32}$/.test(c?.generation??''),currentGenerationMatched:current===expected.current,oldGenerationStillHeld:typeof expected.old==='string'&&current===expected.old,
    historyPresent:!!c?.history,historySuite2:c?.history?.suite===2,historyGenerationMatched:typeof expected.old==='string'&&old===expected.old,enrollmentPresent:!!c?.enrollment,rotationPending:!!c?.rotation,forgottenDevice:p?.forgottenDevice===true,waitingHandlePresent:!!p?.waiting,
    consentVisibleCount:titles.filter(t=>t==="Add this vault's notes to the server's vault?").length,claimantVisibleCount:titles.filter(t=>t==='Pair this device').length,otherModalCount:titles.filter(t=>!["Add this vault's notes to the server's vault?",'Pair this device'].includes(t)).length};
}
export async function waitPairConsentOutcome(read,facts,replacement,pause=ms=>new Promise(r=>setTimeout(r,ms)),now=Date.now,end=now()+20000){
  const started=now();Object.assign(facts,{polls:0,deadlineMs:Math.max(0,end-started),ready:false,refused:false});
  while(now()<end){const after=await read(Math.min(5000,end-now()));facts.before??=after;facts.after=after;facts.polls++;facts.elapsedMs=now()-started;
    facts.refused=after.consentVisibleCount>1||replacement&&after.paired&&!after.currentGenerationMatched&&!after.oldGenerationStillHeld;
    facts.ready=!facts.refused&&now()<=end&&(after.consentVisibleCount===1||after.paired&&(!replacement||after.currentGenerationMatched));
    if(facts.ready||facts.refused)break;if(now()<end)await pause(Math.min(100,end-now()));
  }
  facts.elapsedMs=now()-started;return facts;
}
export async function waitRotationPair(read,facts,pause=ms=>new Promise(r=>setTimeout(r,ms)),now=Date.now,budget=20000){
  const started=now(),end=started+budget;Object.assign(facts,{polls:0,deadlineMs:budget,ready:false,refused:false,transitions:[]});
  while(now()<end){const after=await read(Math.min(5000,end-now()));facts.before??=after;facts.after=after;facts.polls++;facts.elapsedMs=now()-started;
    if(!facts.transitions.length||JSON.stringify(facts.transitions.at(-1))!==JSON.stringify(after)){if(facts.transitions.length===16)facts.transitions.splice(1,1);facts.transitions.push(after);}
    facts.refused=!after.statePresent||!after.generationValid||after.phase==='OTHER'||after.historyPresent&&(!after.historySuite2||!after.historyGenerationMatched)||!after.currentGenerationMatched&&!after.oldGenerationStillHeld;
    facts.ready=!facts.refused&&now()<=end&&after.paired&&after.suite2&&after.phase==='active'&&after.currentGenerationMatched&&after.historyPresent&&after.historySuite2&&after.historyGenerationMatched;
    if(facts.ready||facts.refused)break;if(now()<end)await pause(Math.min(100,end-now()));
  }
  facts.elapsedMs=now()-started;return facts;
}
export function serverUrlCommitMatched(f){return f?.nativeUrlMatches===true&&f?.savedMetadataUrlMatches===true&&f?.paired===false&&f?.nativeDeviceIdAbsent===true;}
export function pointerWitnessMatches(w){return ['mousedown','mouseup','click'].every(type=>w?.[type]?.count===1&&w[type].trusted===true&&w[type].expectedTargetMatched===true);}
export function persistedByteFacts(expected,observed){return {expectedBytes:expected.length,expectedSha256:digest(expected),observedBytes:observed?.length??null,observedSha256:observed?digest(observed):null,exactBytesMatched:!!observed&&observed.equals(expected)};}
export function syntheticNotePath(value){
  const segments=typeof value==='string'?value.split('/'):[];
  if(!segments.length||segments.length>4||value.length>400||!segments.slice(0,-1).every(s=>/^[A-Za-z0-9][A-Za-z0-9 -]{0,63}$/.test(s)&&s.trim()===s)||!/^[A-Za-z0-9][A-Za-z0-9 -]{0,100}(?: \(restored-[a-f0-9]{32}\))?\.md$/.test(segments.at(-1)))throw Error('bounded synthetic note required');
  return value;
}
export function freshTrustRoute(f){
  if(f.candidateLoaded||f.communityPluginsEnabled||f.trustModalCount>1||f.otherModalCount>0)throw Error('fresh native trust entry refused');
  if(!f.candidateManifest)return null;
  if(f.trustModalCount===1){if(!f.trustTitleMatched||f.trustButtons!==1||f.restrictedButtons!==1)throw Error('official native trust prompt changed');return 'INITIAL_TRUST_MODAL';}
  return f.layoutReady?'RESTRICTED_SETTINGS':null;
}
export function candidateLabelMatches(name,version,label){
  const text=String(label??'').replace(/\s+/g,' ').trim(),escaped=version.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
  return text.startsWith(name+' ')&&new RegExp('(?:^|[^A-Za-z0-9])v'+escaped+'(?:$|[^A-Za-z0-9.])').test(text);
}
export function restoredSiblingPath(source,path){
  const prefix=source.slice(0,-3)+' (restored-';
  if(typeof path!=='string'||!path.startsWith(prefix))return false;
  const suffix=path.slice(prefix.length);return suffix.endsWith(').md')&&/^[a-f0-9]{32}$/.test(suffix.slice(0,-4));
}
export function pointerObservation(element,scroll=true){
  if(scroll)element.scrollIntoView({block:'center',inline:'nearest',behavior:'instant'});
  const r=element.getBoundingClientRect(),doc=element.ownerDocument,view=doc.defaultView,v=view.visualViewport;
  const x=r.x+r.width/2,y=r.y+r.height/2,left=v?.offsetLeft??0,top=v?.offsetTop??0,width=v?.width??view.innerWidth,height=v?.height??view.innerHeight;
  const pointerViewportMatched=!!r.width&&!!r.height&&x>=left&&x<left+width&&y>=top&&y<top+height;
  const hit=pointerViewportMatched?doc.elementFromPoint(x,y):null,pointerHitTargetMatched=!!hit&&(hit===element||element.contains(hit));
  const classify=e=>e?{tag:typeof e.tagName==='string'?e.tagName:'UNKNOWN',classes:typeof e.className==='string'&&/^[A-Za-z0-9 _:-]{0,180}$/.test(e.className)?e.className:'OTHER',buttonText:e.tagName==='BUTTON'&&!view.app?.plugins?.plugins?.['obsync-private-sync']?.state?.paired?e.textContent?.trim().slice(0,80):undefined}:null;
  return {ready:pointerViewportMatched&&pointerHitTargetMatched,x,y,pointerViewportMatched,pointerHitTargetMatched,diagnostic:{pointerViewportMatched,pointerHitTargetMatched,target:classify(element),blocker:pointerHitTargetMatched?null:classify(hit)}};
}
export function pointerTarget(element,observe=pointerObservation){
  const result=observe(element);if(!result.pointerViewportMatched)throw Error('ordinary pointer outside visible viewport');if(!result.pointerHitTargetMatched)throw Error('ordinary pointer target occluded');
  return {x:result.x,y:result.y,pointerViewportMatched:true,pointerHitTargetMatched:true};
}
export async function waitPointerReadiness(read,pause=ms=>new Promise(r=>setTimeout(r,ms)),now=Date.now,budget=10000,stableForMs=0){
  const first=read(),end=now()+budget;let current=first,polls=1,anchor=first.ready?{x:first.x,y:first.y}:null,stableSince=first.ready?now():null,coordinateChanges=0;
  const settled=()=>current.ready&&(stableForMs===0||stableSince!==null&&now()-stableSince>=stableForMs);
  while(!settled()&&now()<end){await pause(Math.min(100,end-now()));const next=read();polls++;if(!next.ready){anchor=null;stableSince=null;}else if(!anchor||Math.abs(next.x-anchor.x)>1||Math.abs(next.y-anchor.y)>1){if(anchor)coordinateChanges++;anchor={x:next.x,y:next.y};stableSince=now();}current=next;}
  return {ready:settled()&&now()<=end,before:first.diagnostic,after:current.diagnostic,beforePoint:{x:first.x,y:first.y},afterPoint:{x:current.x,y:current.y},coordinateChanges,requiredStableMs:stableForMs,observedStableMs:stableSince===null?0:now()-stableSince,polls,x:current.x,y:current.y,pointerViewportMatched:current.pointerViewportMatched,pointerHitTargetMatched:current.pointerHitTargetMatched,matchingVisibleControls:current.matchingVisibleControls};
}
export async function waitOwnedPage(read,diagnostic,pause=ms=>new Promise(r=>setTimeout(r,ms)),now=Date.now,budget=20000){
  const started=now(),end=started+budget;Object.assign(diagnostic,{startedAtEpochMs:started,polls:0,ready:false});
  do{
    const all=await read(Math.max(1,end-now()));if(!Array.isArray(all)||all.length>16)throw Error('owned Android debugger page list invalid');
    const pages=all.filter(p=>p.type==='page');diagnostic.polls++;diagnostic.beforePageCount??=pages.length;diagnostic.afterPageCount=pages.length;diagnostic.pageWaitMs=now()-started;diagnostic.observedAtEpochMs=now();
    if(pages.length>1)throw Error('multiple owned Android pages refused');
    if(pages.length===1&&now()<=end){diagnostic.ready=true;return pages[0];}
    if(now()<end)await pause(Math.min(100,end-now()));
  }while(now()<end);
  throw Error('owned initial Android page readiness deadline');
}
// One connection attempt; page discovery is not a completed WebSocket upgrade.
export async function waitOwnedSocketOpen(socket, diagnostic, deadline, now=Date.now) {
  const started=now(),end=Math.min(deadline,started+15000);
  const facts=diagnostic.handshake={budgetMs:Math.max(0,end-started),startedAtEpochMs:started,openEvents:0,errorEvents:0,closeEvents:0,readyStateBefore:socket.readyState};
  let timer;
  try {
    await new Promise((resolve,reject)=>{
      const finish=(error)=>{clearTimeout(timer);socket.removeEventListener('open',open);socket.removeEventListener('error',errorEvent);socket.removeEventListener('close',close);error?reject(error):resolve();};
      const open=()=>{facts.openEvents++;finish(now()<end?null:Error('owned CDP handshake deadline'));};
      const errorEvent=()=>{facts.errorEvents++;finish(Error('owned CDP unavailable'));};
      const close=event=>{facts.closeEvents++;facts.closeCode=Number.isInteger(event.code)?event.code:null;facts.wasClean=event.wasClean===true;finish(Error('owned CDP closed before handshake'));};
      socket.addEventListener('open',open);socket.addEventListener('error',errorEvent);socket.addEventListener('close',close);
      timer=setTimeout(()=>finish(Error('owned CDP handshake deadline')),Math.max(1,end-now()));
      if(socket.readyState===1)open();else if(socket.readyState===3)close({});
    });
  } finally {clearTimeout(timer);facts.elapsedMs=now()-started;facts.readyStateAfter=socket.readyState;}
}
// Complete closure before its owned ADB transport is removed. The whole release
// (close plus scoped forward removal) retains the previous20s cleanup budget.
export async function releaseOwnedConnection(socket, removeForward, diagnostic, deadline, now=Date.now) {
  const started=now(),end=Math.min(deadline,started+20000),closeEnd=Math.min(end,started+2000);
  const facts=diagnostic.release={budgetMs:Math.max(0,end-started),closeBudgetMs:Math.max(0,closeEnd-started),closeCalls:0,closeObserved:false,forwardRemoved:false,readyStateBefore:socket?.readyState??null};
  let timer,failure,closeListener,errorListener;
  try {
    if(socket){
      if(socket.readyState===3)facts.closeObserved=true;
      else await new Promise((resolve,reject)=>{
        const close=event=>{facts.closeObserved=true;facts.closeCode=Number.isInteger(event.code)?event.code:null;facts.wasClean=event.wasClean===true;clearTimeout(timer);socket.removeEventListener('close',close);socket.removeEventListener('error',ignore);resolve();};
        const ignore=()=>{};
        closeListener=close;errorListener=ignore;socket.addEventListener('close',close);socket.addEventListener('error',ignore);
        timer=setTimeout(()=>{socket.removeEventListener('close',close);socket.removeEventListener('error',ignore);reject(Error('owned CDP close deadline'));},Math.max(1,closeEnd-now()));
        if(socket.readyState!==2){facts.closeCalls++;socket.close();}
      });
      if(!facts.closeObserved||socket.readyState!==3||now()>=closeEnd)throw Error('owned CDP close deadline');
    }
  } catch(error){failure=error.message==='owned CDP close deadline'?Error('owned CDP close deadline'):Error('owned CDP close refused');}
  finally {
    clearTimeout(timer);if(closeListener)socket.removeEventListener('close',closeListener);if(errorListener)socket.removeEventListener('error',errorListener);facts.readyStateAfter=socket?.readyState??null;facts.closeElapsedMs=now()-started;
    const remaining=end-now();
    if(remaining<=0)failure??=Error('owned CDP release deadline');
    else try {await removeForward(remaining);facts.forwardRemoved=true;if(now()>=end)failure??=Error('owned CDP release deadline');}
    catch {failure??=Error('owned CDP forward removal refused');}
    facts.elapsedMs=now()-started;
  }
  if(failure)throw failure;
}
export function externalFailure(error){
  const stderr=Buffer.isBuffer(error?.stderr)?error.stderr.toString():typeof error?.stderr==='string'?error.stderr:'';
  const classes=[['git_dubious_ownership',/dubious ownership/],['git_not_repository',/not a git repository/],['git_permission',/Permission denied/],['adb_offline',/device offline/],['adb_missing_device',/device .+ not found/],['adb_unauthorized',/unauthorized/],['file_missing',/No such file or directory/]];
  return {code:/^[A-Z0-9_]{1,32}$/.test(error?.code??'')?error.code:null,status:Number.isInteger(error?.status)?error.status:null,signal:/^SIG[A-Z]{1,16}$/.test(error?.signal??'')?error.signal:null,stderrClass:classes.find(([,pattern])=>pattern.test(stderr))?.[0]??(stderr?'OTHER_REDACTED':'NONE')};
}
export function safeExceptionMessage(description,allowed){const first=String(description??'').split('\n')[0].replace(/^Error: /,'');return allowed.has(first)?first:'owned UI refused or timed out';}
export function ownedVault(path) {
  if (!/^\/storage\/emulated\/0\/Documents\/Obsync-[A-Za-z0-9-]+$/.test(path ?? '')) throw Error('explicit synthetic vault required');
  return path;
}
const ROOT_ENTRIES_COMPLETE='OBSYNC_ROOT_ENTRIES_COMPLETE';
export function parseOwnedRootEntries(vault,bytes){
  ownedVault(vault);
  if(!Buffer.isBuffer(bytes)||!bytes.length||bytes.length>65536||bytes.at(-1)!==0)throw Error('bounded complete owned root entries required');
  const text=bytes.toString('utf8');
  if(!Buffer.from(text,'utf8').equals(bytes))throw Error('owned root entries UTF-8 differs');
  const fields=text.split('\0');fields.pop();
  if(fields.pop()!==ROOT_ENTRIES_COMPLETE)throw Error('owned root entries completion absent');
  if(fields.length>64||new Set(fields).size!==fields.length)throw Error('bounded unique owned root entries required');
  return fields.map(path=>{
    if(!path.startsWith(vault+'/'))throw Error('foreign owned root entry');
    const name=path.slice(vault.length+1);
    if(!name||name==='.'||name==='..'||name.includes('/'))throw Error('immediate owned root entry required');
    return name;
  });
}
export function readOwnedRootEntries(device,vault){
  // -T keeps shell-v2 status without PTY rendering. The end marker also detects
  // a successful local exit after a stream truncated at an entry boundary.
  const command=`find ${androidPathArg(ownedVault(vault))} -mindepth 1 -maxdepth 1 -print0 && printf '${ROOT_ENTRIES_COMPLETE}\\000'`;
  return parseOwnedRootEntries(vault,device('shell','-T',command));
}
export function comparison(creator, claimant) {
  if (creator.length !== 1 || claimant.length !== 1 || !/^\d{3} \d{3}$/.test(creator[0]) || creator[0] !== claimant[0]) throw Error('independent visible comparison refused');
  return true;
}
export function knownNotesMatch(proof,context,local){
  if(proof?.schema!==1||proof.sourceHead!==context.sourceHead||proof.generationHash!==context.generationHash||proof.completeServerInventory!==true||!Number.isFinite(proof.observedAt)||proof.observedAt<=0||proof.observedAt>context.invitationTime||context.invitationTime>context.now||context.now-proof.observedAt>600000||!Array.isArray(proof.files)||!proof.files.length||proof.files.length>32||!Array.isArray(local)||!local.length||local.length>32)throw Error('independent prior known-note proof required');
  const known=new Map();
  for(const file of proof.files){if(typeof file.path!=='string'||known.has(file.path)||!/^[a-f0-9]{64}$/.test(file.sha256??'')||!/^[a-f0-9]{64}$/.test(file.fileIdHash??''))throw Error('known-note proof rows invalid');known.set(file.path,file);}
  if(new Set(local.map(f=>f.path)).size!==local.length||local.some(f=>known.get(f.path)?.sha256!==f.sha256||known.get(f.path)?.fileIdHash!==f.fileIdHash))throw Error('local notes not independently known before pairing');
  return true;
}
// Executed in the observed app document, never an internal product mutation.
export function ordinaryControl(selector, action, expectedText = null,pointer=pointerTarget) {
  const visible = e => !!e && e.getBoundingClientRect().width > 0 && e.getBoundingClientRect().height > 0;
  const matches = [...document.querySelectorAll(selector)].filter(visible).filter(e => expectedText === null || e.textContent.trim() === expectedText);
  if (matches.length !== 1 || matches[0].disabled) throw Error('ordinary control absent or ambiguous');
  const element = matches[0];
  if (action === 'click') { element.scrollIntoView({ block: 'center' }); element.click(); }
  else if (action === 'focus') element.focus();
  else if (action === 'locate')return {...pointer(element),matchingVisibleControls:1};
  else throw Error('unknown ordinary control action');
  return { method: 'DOM ordinary-control ' + action, matchingVisibleControls: 1 };
}
export function visibleComparisons() {
  const found = { creator: [], claimant: [] };
  for (const modal of document.querySelectorAll('.modal:not(.mod-settings)')) {
    const box = modal.getBoundingClientRect();
    if (!box.width || !box.height) continue;
    const text = modal.textContent ?? '';
    for (const match of text.matchAll(/Approve only if the new device shows the code (\d{3} \d{3})\./g)) found.creator.push(match[1]);
    for (const match of text.matchAll(/Waiting for approval on the other device\. Its prompt shows the code (\d{3} \d{3}):/g)) found.claimant.push(match[1]);
  }
  return found;
}
export function selectAllText(){
  const element=document.activeElement;
  if(typeof element?.value==='string'&&typeof element.select==='function'){
    element.select();if(element.selectionStart!==0||element.selectionEnd!==element.value.length)throw Error('native field selection differs');
  }else if(element?.isContentEditable){
    const range=element.ownerDocument.createRange(),selection=element.ownerDocument.getSelection();range.selectNodeContents(element);selection.removeAllRanges();selection.addRange(range);if(selection.toString()!==element.textContent)throw Error('native title selection differs');
  }else throw Error('native text selection unavailable');
  return true;
}
export function nativeScreen(xml,input){
  const entities={'&quot;':'"','&apos;':"'",'&amp;':'&','&lt;':'<','&gt;':'>'};
  const decode=value=>value.replace(/&(?:quot|apos|amp|lt|gt);/g, entity=>entities[entity]);
  const nodes=[...xml.matchAll(/<node\b[^>]*>/g)].map(([tag])=>Object.fromEntries([...tag.matchAll(/([a-z-]+)="([^"]*)"/g)].map(([,key,value])=>[key,decode(value)])));
  const allowed=new Set(['com.android.settings','com.google.android.permissioncontroller','com.android.permissioncontroller','com.google.android.documentsui','com.android.documentsui']);
  const selected=nodes.filter(n=>allowed.has(n.package)&&n.enabled==='true');
  const matches=selected.filter(n=>n['resource-id']===input.nativeResourceId&&n.text===input.nativeText&&n.clickable==='true'&&(input.nativeBounds===undefined||n.bounds===input.nativeBounds)&&(input.nativeCheckable===undefined||n.checkable===String(input.nativeCheckable))&&(input.nativeChecked===undefined||n.checked===String(input.nativeChecked)));
  const label=!!input.nativeRequiredText&&selected.some(n=>n.text===input.nativeRequiredText);
  return {selected,matches,ready:label&&matches.length===1,diagnostic:{hierarchy:xml.includes('<hierarchy'),nodeCount:nodes.length,allowedNodeCount:selected.length,appVisible:nodes.some(n=>n.package==='md.obsidian'),settingsVisible:nodes.some(n=>n.package==='com.android.settings'),requiredLabel:label,targetCount:matches.length}};
}
export function nativeReadiness(app,vaultPath){
  const facts={vaultPresent:!!app?.vault?.adapter,ownedVault:app?.vault?.adapter?.basePath===vaultPath,layoutReady:app?.workspace?.layoutReady===true,pluginRegistryPresent:!!app?.plugins?.plugins&&typeof app.plugins.plugins==='object',manifestRegistryPresent:!!app?.plugins?.manifests&&typeof app.plugins.manifests==='object',normalPluginSettingsAvailable:typeof app?.setting?.open==='function'&&typeof app?.setting?.openTabById==='function'};
  return {...facts,ready:Object.values(facts).every(v=>v===true)};
}
export async function waitNativeReadiness(read,pause=ms=>new Promise(r=>setTimeout(r,ms)),now=Date.now,budget=20000){
  const started=now(),before=read(),end=started+budget;let after=before,polls=1;
  for(;;){
    if(after.vaultPresent&&!after.ownedVault)throw Error('foreign vault');
    if(after.ready||now()>=end)return {before,after,polls,ready:after.ready&&now()<=end};
    await pause(100);after=read();polls++;
  }
}
function privateJson(path) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o077) || stat.nlink !== 1) throw Error('private input required');
  return JSON.parse(readFileSync(path, 'utf8'));
}
async function main(args) {
  const options = {};
  while (args[0]?.startsWith('--')) { const key = args.shift().slice(2); options[key] = args.shift(); }
  const [command] = args;
  if (!options.manifest || !command || args.length !== 1) throw Error('usage: --manifest private/android.json [--input private.json] command');
  const state = privateJson(options.manifest), input = options.input ? privateJson(options.input) : {};
  const run = realpathSync(state.run);
  const usb=state.targetKind==='usb';
  if(state.format!==1||resolve(options.manifest)!==join(run,'android.json')||!Number.isInteger(state.adbPort)||!existsSync(join(run,'evidence/android-ready.json'))||state.run!==run||!Number.isFinite(state.expiresAtEpoch))throw Error('ready owned controller required');
  if(usb){
    const argv=[join(state.sdk,'platform-tools/adb'),'--one-device',state.serial,'-L','tcp:'+state.adbPort,'server','nodaemon'];
    if(!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(state.serial)||state.serial.startsWith('emulator-')||state.usb?.ownerApprovedDedicatedFixture!==true||state.usb.serialSha256!==digest(Buffer.from(state.serial))||state.processes?.emulator||JSON.stringify(state.processes?.adb?.argv)!==JSON.stringify(argv)||!state.processes.adb.identity.endsWith(argv.join(' ')))throw Error('one supplied owned USB target required');
    if(input.vaultPath!==undefined&&input.vaultPath!==state.usb.vaultPath)throw Error('USB fixture vault differs');
  }else if(state.targetKind!==undefined&&state.targetKind!=='emulator'||!state.processes?.emulator||!state.processes?.adb||!/^emulator-(555[468]|55[678][02468])$/.test(state.serial))throw Error('owned emulator required');
  const adb = join(state.sdk, 'platform-tools/adb'), environment = usb ? {...state.environment} : { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('ADB') && !key.startsWith('ANDROID_'))), ...state.environment };
  function live() {
    if (Date.now() / 1000 >= state.expiresAtEpoch) throw Error('session expired');
    for (const record of [state.holder, ...Object.values(state.processes)]) {
      if (!record || execFileSync('ps', ['-p', String(record.pid), '-o', 'lstart=,command='], { encoding: 'utf8' }).trim() !== record.identity) throw Error('owned process identity changed');
    }
  }
  function device(...argv) { return deviceBudget(20000,...argv); }
  function deviceBudget(budgetMs,...argv) {
    if(!Number.isFinite(budgetMs)||budgetMs<=0)throw Error('native note readiness deadline');
    live();
    return execFileSync(adb, ['-P', String(state.adbPort), '-s', state.serial, ...argv], { env: environment, timeout: Math.min(20000,budgetMs, Math.max(1, state.expiresAtEpoch * 1000 - Date.now())), maxBuffer: 16 << 20, stdio: ['ignore', 'pipe', 'pipe'] });
  }
  function installProcessFacts() {
    const facts={atEpochMs:Date.now()};
    for(const [name,record] of [['holder',state.holder],['adb',state.processes.adb],['emulator',state.processes.emulator]]){
      if(!record){facts[name]=usb&&name==='emulator'?'NOT_APPLICABLE':'NOT_RECORDED';continue;}
      try{facts[name]=execFileSync('ps',['-p',String(record.pid),'-o','lstart=,command='],{encoding:'utf8',timeout:1000}).trim()===record.identity?'MATCH':'CHANGED';}
      catch{facts[name]='UNAVAILABLE';}
    }
    return facts;
  }
  const receipts=[];
  const receipt = value => {
    const result = { at: new Date().toISOString(), command,evidenceClass:input.evidenceClass==='LOCAL_CONTROL_PROTOTYPE'?input.evidenceClass:undefined, platform: usb?'Android USB device':'Android emulator', physicalPhone:usb?'USB_JOURNEY_OBSERVED':'NOT_RUN',freshPhysicalEnvironment:usb?false:undefined, sourceHead: state.sourceHead, driverSha256: digest(readFileSync(new URL(import.meta.url))),connectReadiness,...value };
    receipts.push(result);
  };
  let forward, ws, next = 0, stage='connect_android_webview',nativeObservations,startupReadiness,enableReadiness,communityTrustReadiness,pointerReadiness,connectReadiness,persistedNoteReadback,controlReadiness,pointerWitness,serverUrlReadiness,pairingReadiness,scopeSaveReadiness,knownNotesIndexReadiness,noteReadiness,replacementReadiness,installReadbacks,folderIndexReadiness;
  const pending = new Map(), networkFailures = [], blockedReasons = [];
  async function send(method, params = {},budgetMs=30000) {
    live();
    return new Promise((resolveAnswer, reject) => {
      const id = ++next, timer = setTimeout(() => { pending.delete(id); reject(Error('CDP command deadline')); }, Math.max(1,Math.min(30000,budgetMs)));
      pending.set(id, { resolve: resolveAnswer, reject, timer });
      ws.send(JSON.stringify({ id, method, params }));
    }).then(answer=>{if(answer.error)throw Error('CDP method refused');return answer;});
  }
  async function evaluate(body, params = {}, requireVault = true,budgetMs=30000) {
    const answer = await send('Runtime.evaluate', { expression: `(async()=>{const P=${scriptJson(params)};${requireVault ? `if(window.app?.vault?.adapter?.basePath!==${scriptJson(ownedVault(input.vaultPath))})throw Error('foreign vault');` : ''}${body}})()`, awaitPromise: true, returnByValue: true, timeout: Math.max(1,Math.min(25000,budgetMs)) },budgetMs);
    if (answer.error || answer.result?.exceptionDetails){const allowed=new Set([...readFileSync(new URL(import.meta.url),'utf8').matchAll(/\bError\('([^']+)'\)/g)].map(m=>m[1]));throw Error(safeExceptionMessage(answer.result?.exceptionDetails?.exception?.description,allowed));}
    return answer.result?.result?.value;
  }
  async function connect(deadline=state.expiresAtEpoch*1000) {
    const started=Date.now(),end=Math.min(deadline,state.expiresAtEpoch*1000);
    connectReadiness={connectionStartedAtEpochMs:started,connectionBudgetMs:Math.max(0,end-started),httpRequests:0};
    const remaining=()=>{const value=end-Date.now();if(value<=0)throw Error('owned Android connection deadline');return value;};
    stage='read_owned_android_app_pid';
    const pid = deviceBudget(remaining(),'shell', 'pidof', 'md.obsidian').toString().trim();
    if (!/^\d+$/.test(pid)||Number(pid)<=1) throw Error('one owned app process required');
    connectReadiness.appPid=Number(pid);stage='wait_owned_initial_android_page';
    forward = Number(deviceBudget(remaining(),'forward', 'tcp:0', `localabstract:webview_devtools_remote_${pid}`).toString().trim());
    const page=await waitOwnedPage(async budget=>{
      const request={number:++connectReadiness.httpRequests,startedAtEpochMs:Date.now(),headersReceived:false,bodyCompleted:false};
      connectReadiness.firstHttpRequest??=request;connectReadiness.lastHttpRequest=request;
      try{
        const response=await fetch(`http://127.0.0.1:${forward}/json/list`,{signal:AbortSignal.timeout(Math.max(1,Math.floor(Math.min(5000,budget,remaining()))))});
        request.headersReceived=true;request.status=response.status;remaining();
        if(response.status!==200)throw Error('owned Android debugger page endpoint refused');
        const value=await response.json();request.bodyCompleted=true;remaining();request.result='COMPLETE';return value;
      }catch(error){
        request.result='FAIL';request.errorName=['Error','TypeError','TimeoutError','AbortError','SyntaxError'].includes(error.name)?error.name:'OTHER';
        request.errorCode=['ECONNREFUSED','ECONNRESET','UND_ERR_SOCKET','ETIMEDOUT','UND_ERR_CONNECT_TIMEOUT','UND_ERR_HEADERS_TIMEOUT','UND_ERR_BODY_TIMEOUT'].includes(error.cause?.code)?error.cause.code:'OTHER';
        connectReadiness.firstHttpFailure??=request;throw error;
      }finally{request.elapsedMs=Date.now()-request.startedAtEpochMs;}
    },connectReadiness,undefined,undefined,Math.min(20000,remaining()));
    remaining();
    const address = new URL(page.webSocketDebuggerUrl);
    if (address.protocol !== 'ws:' || !['localhost', '127.0.0.1'].includes(address.hostname) || Number(address.port) !== forward) throw Error('foreign debugger endpoint');
    connectReadiness.targetIdSha256=digest(Buffer.from(String(page.id??'')));
    connectReadiness.socketPathSha256=digest(Buffer.from(address.pathname));
    stage='wait_owned_android_websocket';
    ws = new WebSocket(address);
    await waitOwnedSocketOpen(ws,connectReadiness,end);
    remaining();connectReadiness.socketConnected=true;connectReadiness.connectionElapsedMs=Date.now()-started;
    ws.onerror=()=>{};
    ws.onmessage = event => { const answer = JSON.parse(event.data), request = pending.get(answer.id); if (answer.method === 'Network.loadingFailed') { networkFailures.push(answer.params.errorText); if(answer.params.blockedReason)blockedReasons.push(answer.params.blockedReason); } if (request) { clearTimeout(request.timer); pending.delete(answer.id); request.resolve(answer); } };
    ws.onclose = () => { for (const p of pending.values()) { clearTimeout(p.timer); p.reject(Error('owned CDP closed')); } pending.clear(); };
    return Number(pid);
  }
  async function releaseConnection(){
    const socket=ws,port=forward;ws=undefined;forward=undefined;
    if(!socket&&!port)return;
    connectReadiness??={};
    await releaseOwnedConnection(socket,async budget=>{if(port)deviceBudget(budget,'forward','--remove',`tcp:${port}`);},connectReadiness,state.expiresAtEpoch*1000);
  }
  async function trustedPointerClick(spec,requireVault=true){
    const budget=()=>{const remaining=spec.deadline===undefined?30000:Math.min(30000,spec.deadline-Date.now());if(remaining<=0)throw Error('saved selected scope deadline');return remaining;};
    await evaluate(`const visible=e=>e.getBoundingClientRect().width>0&&e.getBoundingClientRect().height>0,es=[...document.querySelectorAll(P.selector)].filter(visible).filter(e=>(P.text==null||e.textContent.trim()===P.text)&&(!P.modalTitle||e.closest('.modal')?.querySelector('.modal-title')?.textContent.trim()===P.modalTitle)&&(!P.settingRow||e.closest('.setting-item')?.querySelector('.setting-item-name')?.textContent.trim()===P.settingRow));if(es.length!==1)throw Error('ordinary control absent or ambiguous');const target=es[0],point=(${pointerTarget.toString()})(target,e=>(${pointerObservation.toString()})(e,P.scroll!==false));if(Math.abs(point.x-P.x)>1||Math.abs(point.y-P.y)>1)throw Error('ordinary control moved before trusted click');const events={},listeners={};for(const type of ['mousedown','mouseup','click']){events[type]={count:0,trusted:false,expectedTargetMatched:false};listeners[type]=e=>{const r=events[type];r.count++;r.trusted=e.isTrusted===true;r.expectedTargetMatched=e.composedPath().includes(target)||target.contains(e.target);};document.addEventListener(type,listeners[type],true);}window.obsyncJourneyPointer={events,listeners,target};return true;`,{selector:spec.selector,text:spec.expectedText,modalTitle:spec.modalTitle,settingRow:spec.settingRow,scroll:spec.scroll,x:spec.point.x,y:spec.point.y},requireVault,budget());
    await send('Input.dispatchMouseEvent',{type:'mousePressed',x:spec.point.x,y:spec.point.y,button:'left',clickCount:1},budget());
    await send('Input.dispatchMouseEvent',{type:'mouseReleased',x:spec.point.x,y:spec.point.y,button:'left',clickCount:1},budget());
    pointerWitness=await evaluate(`const w=window.obsyncJourneyPointer;if(!w)throw Error('ordinary pointer witness absent');for(const [type,listener]of Object.entries(w.listeners))document.removeEventListener(type,listener,true);const value={...w.events,expectedTargetConnectedAfter:w.target.isConnected};delete window.obsyncJourneyPointer;return value;`,{},requireVault,budget());if(!pointerWitnessMatches(pointerWitness))throw Error('ordinary trusted click not delivered');
  }
  async function readyNativeStartup(){
    startupReadiness=await evaluate(`const read=()=>(${nativeReadiness.toString()})(window.app,P.vaultPath);return await (${waitNativeReadiness.toString()})(read);`,{vaultPath:input.vaultPath},false);
    if(!startupReadiness.ready)throw Error('native app plugin registry readiness deadline');
  }
  try {
    if(['onboard','note-create','pair-submit','rotation-pair-submit','folder-create','folder-rename','folder-case-rename','previous-history-restore'].includes(command)){
      let stepNumber=0;const automaticAttempt=Date.now().toString(36)+'-'+process.pid;
      async function step(name,subcommand,data){
        stage=name;
        const path=join(run,'private',`automatic-${command}-${automaticAttempt}-${++stepNumber}-${name}.json`);
        writeFileSync(path,JSON.stringify(data)+'\n',{mode:0o600,flag:'wx'});
        await main(['--manifest',options.manifest,'--input',path,subcommand]);
        if(process.exitCode&&subcommand==='enable')await main(['--manifest',options.manifest,'--input',path,'enable-diagnostic']);
        if(process.exitCode)throw Error('automatic journey stage failed; earlier receipt retained');
      }
      const base={vaultPath:ownedVault(input.vaultPath),evidenceClass:input.evidenceClass};
      if(command==='onboard'){
        if(usb)await step('refuse_existing_configured_usb_vault','usb-fixture-ready',base);
        stage='refuse_existing_vault';
        device('shell','test','!','-e',base.vaultPath);
        const click=(expectedText)=>({onboarding:true,selector:'button',expectedText,action:'click'});
        await step('create_vault_screen','control',click('Create a vault'));
        await step('continue_without_sync','control',click('Continue without sync'));
        await step('enter_vault_name','type',{onboarding:true,selector:'input[placeholder="My vault"]',text:base.vaultPath.split('/').at(-1)});
        await step('request_device_storage','control',click('Create a vault'));
        await step('request_file_access','control',click('Allow file access'));
        await step('grant_file_access','native-control',{nativeResourceId:'',nativeText:'',nativeCheckable:true,nativeChecked:false,nativeRequiredText:'Allow access to manage all files'});
        await step('return_after_file_access','native-back',{nativeRequiredText:'All files access',nativeRequireChecked:true});
        await step('observe_resumed_documents_picker','native-ready',{nativeResourceId:'android:id/button1',nativeText:'USE THIS FOLDER',nativeRequiredText:'Files in Documents'});
        await step('select_documents','native-control',{nativeResourceId:'android:id/button1',nativeText:'USE THIS FOLDER',nativeRequiredText:'Files in Documents'});
        await step('consent_documents_access','native-control',{nativeResourceId:'android:id/button1',nativeText:'ALLOW',nativeRequiredText:'Allow Obsidian to access files in Documents?'});
        await step('confirm_created_vault','wait-vault',base);
        await step('install_exact_assets','install',{...base,sourceDir:input.sourceDir,preflight:input.preflight});
        await step('restart_installed_inventory_while_restricted','restart',{...base,controllerPath:input.controllerPath});
        await step('ordinary_known_candidate_trust','community-trust-choice',base);
        await step('wait_ordinary_trust_completion','community-trust-ready',base);
        await step('confirm_vault_after_trust','wait-vault',base);
        await step('open_installed_plugin','settings',{...base,tab:'community-plugins'});
        await step('confirm_normal_installed_inventory','community-trust-ready',base);
        await step('enable_candidate','enable',base);
        await step('confirm_unpaired_native_store','unpaired-ready',base);
        receipt({result:'PASS',stage:'onboarding_ready',ordinaryPermissionsAndTrust:true,installedAssetReadbackRequired:true,paired:false,metadataOrCredentialsSeeded:false});
      }else if(command==='note-create'){
        if(!/^[A-Za-z0-9-]+\.md$/.test(input.note??'')||typeof input.text!=='string'||!input.text.length||input.text.length>65536)throw Error('bounded synthetic note required');
        await step('close_settings_for_note','close-settings',base);
        await step('open_empty_new_tab','new-tab',base);
        await step('create_new_note','control',{...base,selector:'.empty-state-action',expectedText:'Create new note',action:'click'});
        await step('name_new_note','type',{...base,selector:'.inline-title',text:input.note.slice(0,-3),selectAll:true,pressEnter:true});
        await step('type_new_note','type',{...base,selector:'.cm-content',note:input.note,text:input.text});
        await step('independent_new_note_bytes','note-read',{...base,note:input.note,text:input.text,expectPaired:input.expectPaired});
        receipt({result:'PASS',stage:'native_note_created',ordinaryNewNoteAndTitle:true,nativeEditorInput:true,independentAdbReadback:true,bytes:Buffer.byteLength(input.text),sha256:digest(Buffer.from(input.text))});
      }else if(command==='folder-case-rename'){
        // Explicit two ordinary renames: mobile's native case-insensitive storage
        // can reject a direct case-only destination while its adapter is sensitive.
        if(!['Team docs','team docs'].includes(input.from)||!['Team docs','team docs'].includes(input.to)||input.from===input.to)throw Error('opposite selected folder case endpoints required');
        const intermediate='Obsync-case-rename',started=performance.now(),end=started+180000;
        const beforeSnapshot=join(run,'private',`folder-before-case-${automaticAttempt}.json`);
        const remaining=()=>{if(performance.now()>=end)throw Error('ordinary folder case rename deadline');};
        const boundedStep=async(name,subcommand,data)=>{remaining();await step(name,subcommand,data);remaining();};
        const exactEntries=(name,expected,absent)=>{
          stage=name;remaining();const names=readOwnedRootEntries(device,base.vaultPath);remaining();
          if(names.filter(n=>n===expected).length!==1||absent.some(n=>names.includes(n)))throw Error('explicit folder case rename entries differ');
        };
        exactEntries('verify_original_and_fresh_intermediate',input.from,[intermediate,input.to]);
        await boundedStep('snapshot_original_case_descendants','folder-snapshot',{...base,folder:input.from,output:beforeSnapshot});
        const originalBaseline=privateJson(beforeSnapshot),baselineJson=JSON.stringify(originalBaseline);
        if(originalBaseline.sourceHead!==state.sourceHead||originalBaseline.folder!==input.from||!Array.isArray(originalBaseline.files)||originalBaseline.files.length>32)throw Error('original folder case baseline differs');
        await boundedStep('ordinary_case_rename_to_intermediate','folder-rename',{...base,from:input.from,to:intermediate});
        exactEntries('verify_exact_case_intermediate',intermediate,[input.from,input.to]);
        await boundedStep('ordinary_case_rename_to_final','folder-rename',{...base,from:intermediate,to:input.to});
        exactEntries('verify_exact_case_final',input.to,[input.from,intermediate]);
        await boundedStep('verify_original_case_descendants_at_final','folder-verify',{...base,folder:input.to,oldFolder:input.from,beforeSnapshot});
        if(JSON.stringify(privateJson(beforeSnapshot))!==baselineJson)throw Error('original folder case baseline changed');
        const descendants=originalBaseline.files.length;
        const elapsedMs=Math.floor(performance.now()-started);if(elapsedMs>=180000)throw Error('ordinary folder case rename deadline');
        receipt({result:'PASS',stage:'explicit_two_step_folder_case_rename_verified',folder:input.to,oldFolder:input.from,intermediate,workflow:'TWO_ORDINARY_RENAMES',ordinaryRenameCount:2,directSingleStepCaseRename:false,originalBaselinePreserved:true,intermediateAbsent:true,originalAbsent:true,finalFolder:input.to,independentAdbDirectory:true,sharedBudgetMs:180000,elapsedMs,descendants,method:'two ordinary Files renames through fixed fresh intermediate; original independent descendant baseline at final',syncClaim:false});
      }else if(command==='folder-create'||command==='folder-rename'){
        const valid=f=>typeof f==='string'&&/^[A-Za-z][A-Za-z0-9 -]{0,63}$/.test(f)&&f.trim()===f;
        const target=command==='folder-create'?input.folder:input.to;
        if(!valid(target)||(command==='folder-rename'&&(!valid(input.from)||input.from===target)))throw Error('explicit synthetic root folder required');
        const beforeSnapshot=join(run,'private',`folder-before-${automaticAttempt}.json`);
        if(readOwnedRootEntries(device,base.vaultPath).includes(target))throw Error('fresh exact folder name required');
        await step('close_settings_for_folder','close-settings',base);
        await step('show_owned_files','show-files',base);
        if(command==='folder-create'){
          await step('click_new_folder','control',{...base,selector:'.nav-action-button[aria-label="New folder"]',action:'click'});
        }else{
          await step('snapshot_folder_descendants','folder-snapshot',{...base,folder:input.from,output:beforeSnapshot});
          await step('open_folder_context_menu','control',{...base,selector:'.nav-folder-title[data-path="'+input.from+'"]',action:'contextmenu'});
          await step('choose_folder_rename','control',{...base,selector:'.menu-item-title',expectedText:'Rename...',action:'click'});
        }
        await step('enter_folder_name','type',{...base,selector:'.nav-folder-title.is-being-renamed .nav-folder-title-content',text:target,selectAll:true,pressEnter:true});
        await step('independent_folder_verification','folder-verify',{...base,folder:target,oldFolder:command==='folder-rename'?input.from:undefined,beforeSnapshot:command==='folder-rename'?beforeSnapshot:undefined});
        receipt({result:'PASS',stage:'ordinary_folder_action_verified',folder:target,oldFolder:command==='folder-rename'?input.from:undefined,method:'ordinary Files controls, trusted pointer/context menu and text input',independentAdbDirectory:true,syncClaim:false});
      }else if(command==='previous-history-restore'){
        if(!/^[A-Za-z0-9-]+\.md$/.test(input.note??'')||typeof input.text!=='string'||Buffer.byteLength(input.text)<1||Buffer.byteLength(input.text)>=1024)throw Error('small retained root note fixture required');
        const history={...base,note:input.note,text:input.text};
        await step('verify_old_history_custody','rotation-pair-status',{...base,expectedGenerationHash:input.expectedGenerationHash,expectedOldGenerationHash:input.expectedOldGenerationHash});
        await step('snapshot_before_history_restore','history-baseline',history);
        await step('open_ordinary_history','history-open',base);
        await step('select_explicit_previous_generation','history-previous',base);
        await step('filter_retained_filename','type',{...base,selector:'.modal:not(.mod-settings) input[type="text"]',text:input.note,selectAll:true});
        await step('restart_filtered_retained_search','control',{...base,selector:'.modal:not(.mod-settings) button',expectedText:'Restart search',action:'click'});
        await step('search_retained_history','control',{...base,selector:'.modal:not(.mod-settings) button',expectedText:'Search',action:'click'});
        await step('restore_unique_retained_content','history-pick',history);
        await step('independent_restored_history_bytes','history-readback',history);
        await step('verify_history_did_not_change_live_generation','rotation-pair-status',{...base,expectedGenerationHash:input.expectedGenerationHash,expectedOldGenerationHash:input.expectedOldGenerationHash});
        receipt({result:'PASS',stage:'previous_history_restored_and_read',explicitPreviousGenerationUi:true,ordinaryRestoreCopy:true,knownRetainedBytesMatch:true,currentNoteUnchanged:true,independentAdbBytesBeforeEditor:true,restoredFixtureFile:'private/android-history-restored.json'});
      }else{
        const st=lstatSync(input.invitationFile);
        if(!st.isFile()||st.isSymbolicLink()||st.uid!==process.getuid()||(st.mode&0o077)||st.nlink!==1)throw Error('private invitation custody required');
        const invitation=readFileSync(input.invitationFile,'utf8').trim();
        if(!/^[A-Z2-7]{128}$/.test(invitation)||typeof input.serverUrl!=='string'||!input.serverUrl.startsWith('https://'))throw Error('fresh invitation and HTTPS endpoint required');
        await step('open_pairing_settings','settings',{...base,tab:'obsync-private-sync'});
        if(command==='rotation-pair-submit'){
          const bs=lstatSync(input.oldBackupFile);
          if(!bs.isFile()||bs.isSymbolicLink()||bs.uid!==process.getuid()||(bs.mode&0o077)||bs.nlink!==1)throw Error('private complete old backup required');
          const backup=readFileSync(input.oldBackupFile,'utf8').trim();
          if(!backup.startsWith('obsync-recovery-v2 ')||backup.length>1024)throw Error('private complete old backup required');
          await step('open_pair_after_rotation','control',{...base,selector:'button',expectedText:'Pair after rotation',action:'click'});
          await step('enter_complete_old_backup','type',{...base,selector:'.modal:not(.mod-settings) textarea',text:backup});
          await step('continue_to_replacement_pairing','control',{...base,selector:'.modal:not(.mod-settings) button',expectedText:'Continue to pairing',action:'click'});
        }else{
          await step('enter_pairing_endpoint','type',{...base,selector:'input[placeholder="sync.example.org"]',text:input.serverUrl,selectAll:true});
          await step('close_settings_to_adopt_endpoint','close-settings',base);
          await step('confirm_ordinary_endpoint_commit','unpaired-server-ready',{...base,serverUrl:input.serverUrl});
          await step('reopen_committed_pairing_settings','settings',{...base,tab:'obsync-private-sync'});
          await step('open_pair_this_device','control',{...base,selector:'button',expectedText:'Pair this device',action:'click'});
        }
        await step('enter_fresh_invitation','type',{...base,selector:'.modal:not(.mod-settings) input',text:invitation});
        await step('submit_pairing_claim','control',{...base,selector:'.modal:not(.mod-settings) button',expectedText:'Pair',action:'click'});
        await step('independent_claimant_observation','pair-observe',base);
        receipt({result:'OBSERVED',stage:'claimant_comparison_ready',independentClaimantObservation:true,creatorApproval:'REQUIRED',replacementPairing:command==='rotation-pair-submit',localUploadConsent:'NOT_YET_OBSERVED'});
      }
      return;
    }
    if(command==='usb-fixture-ready'){
      if(!usb)throw Error('USB fixture guard requires USB target');
      device('shell','test','!','-e',ownedVault(input.vaultPath));
      await connect();await send('Runtime.enable');
      const fresh=await evaluate(`const visible=e=>e.getClientRects().length;return !window.app?.vault?.adapter?.basePath&&[...document.querySelectorAll('button')].filter(e=>visible(e)&&!e.disabled&&e.textContent.trim()==='Create a vault').length===1;`,{},false);
      if(!fresh)throw Error('existing configured vault or unsupported USB onboarding screen; no app data changed');
      receipt({result:'PASS',existingConfiguredVaultAbsent:true,freshTestPathAbsent:true,existingAppDataPreserved:true,freshPhysicalEnvironment:false});return;
    }
    if(command==='restart'){
      stage='controller_verified_app_restart';
      const controller=input.controllerPath??new URL('./android-session.py',import.meta.url).pathname,stat=lstatSync(controller);
      if(!stat.isFile()||stat.isSymbolicLink()||!controller.endsWith('/android-session.py'))throw Error('shared owned Android controller required');
      live();execFileSync('python3',['-B',controller,'restart-app','--run',run],{env:process.env,timeout:60000,stdio:['ignore','pipe','pipe']});
      receipt({result:'RESTARTED',method:'shared Android controller restart-app',oldPidAndDebuggerSocketProof:'CONTROLLER_RECEIPT',automaticIdle:'NOT_YET_OBSERVED'});
      return;
    }
    if (command === 'native-inspect' || command === 'native-control' || command === 'native-back'||command==='native-ready') {
      stage='wait_exact_native_controls';nativeObservations=[];
      const deadline=Date.now()+30000;let observed;
      do{
        const xml=device('exec-out','uiautomator','dump','/dev/tty').toString();observed=nativeScreen(xml,input);
        nativeObservations.push({at:new Date().toISOString(),...observed.diagnostic});
        const backReady=observed.diagnostic.requiredLabel&&(!input.nativeRequireChecked||observed.selected.some(n=>n.checkable==='true'&&n.checked==='true'));
        if(command==='native-inspect'||['native-control','native-ready'].includes(command)&&observed.ready||command==='native-back'&&backReady)break;
        if(observed.matches.length>1)throw Error('native control absent or ambiguous');
        if(Date.now()<deadline)await new Promise(r=>setTimeout(r,250));
      }while(Date.now()<deadline);
      const {selected,matches}=observed;
      if(['native-control','native-ready'].includes(command)&&!observed.ready||command==='native-back'&&(!observed.diagnostic.requiredLabel||input.nativeRequireChecked&&!selected.some(n=>n.checkable==='true'&&n.checked==='true')))throw Error('exact native screen readiness deadline');
      if (!selected.length) throw Error('owned app or permission UI required');
      if(input.nativeRequiredText&&!selected.some(n=>n.text===input.nativeRequiredText))throw Error('native screen label changed');
      if(command==='native-ready'){
        receipt({result:'PASS',readOnly:true,method:'passive exact native screen and unique ordinary control observation',expectedScreenLabel:input.nativeRequiredText,expectedControlText:input.nativeText,observedNativePackage:matches[0].package,matchingControls:1,nativeObservations});return;
      }
      if(command==='native-back'){
        if(!input.nativeRequiredText||input.nativeRequireChecked&&!selected.some(n=>n.checkable==='true'&&n.checked==='true'))throw Error('verified native permission before back required');
        device('shell','input','keyevent','4');receipt({result:'ACTION_COMPLETED',method:'ordinary Android Back after verified permission',nativeObservations});return;
      }
      if (command === 'native-inspect') receipt({ result: 'OBSERVED', method: 'UiAutomator owned native UI', controls: selected.map(n => ({ text: n.text, description: n['content-desc'], resourceId: n['resource-id'], class: n.class, clickable: n.clickable, checkable: n.checkable, checked: n.checked, bounds: n.bounds })) });
      else {
        stage='activate_native_control';
        if (typeof input.nativeResourceId !== 'string' || typeof input.nativeText !== 'string') throw Error('observed native control identity required');
        if (matches.length !== 1) throw Error('native control absent or ambiguous');
        const bounds = /^\[(\d+),(\d+)\]\[(\d+),(\d+)\]$/.exec(matches[0].bounds)?.slice(1).map(Number);
        if (!bounds || bounds[2] <= bounds[0] || bounds[3] <= bounds[1]) throw Error('native control bounds unavailable');
        device('shell', 'input', 'tap', String(Math.floor((bounds[0] + bounds[2]) / 2)), String(Math.floor((bounds[1] + bounds[3]) / 2)));
        receipt({ result: 'ACTION_COMPLETED', method: 'UiAutomator exact identity + ADB input tap', matchingControls: 1,nativeObservations });
      }
      return;
    }
    let appPid;
    if(command==='wait-vault'){
      stage='wait_owned_vault_webview';const end=Date.now()+45000;
      appPid=await connect(end);
      if(!appPid||Date.now()>=end)throw Error('owned vault WebView startup deadline');
      stage='wait_native_app_plugin_registry';await readyNativeStartup();
      receipt({result:'PASS',ownedVaultConfirmed:true,startupReadiness,method:'passive startup exact vault, ready layout, plugin registry and settings methods'});return;
    }else appPid=await connect();
    if(command==='unpaired-server-ready'){
      stage='wait_ordinary_server_url_commit';
      const target=new URL(input.serverUrl);if(target.protocol!=='https:'||target.username||target.password||target.search||target.hash||target.pathname!=='/')throw Error('ordinary HTTPS server endpoint required');
      const expected=target.origin,end=Date.now()+15000;let polls=0;
      do{polls++;const native=await evaluate(`const p=app.plugins?.plugins?.['obsync-private-sync'];if(!p?.state||p.state.paired||p.state.data.deviceId!==null)throw Error('fresh unpaired native store required');return {nativeUrlMatches:p.state.data.serverUrl===P.expected,paired:false,nativeDeviceIdAbsent:true};`,{expected});let saved=false;try{const metadata=JSON.parse(device('exec-out','cat',ownedVault(input.vaultPath)+'/.obsidian/plugins/obsync-private-sync/data.json').toString());saved=metadata.serverUrl===expected;}catch(error){if(error.name!=='SyntaxError'&&error.status!==1)throw error;}serverUrlReadiness={...native,savedMetadataUrlMatches:saved,polls,expectedUrlSha256:digest(Buffer.from(expected))};if(serverUrlCommitMatched(serverUrlReadiness))break;await new Promise(r=>setTimeout(r,100));}while(Date.now()<end);
      if(!serverUrlCommitMatched(serverUrlReadiness))throw Error('ordinary server URL commit deadline');
      receipt({result:'PASS',readOnly:true,ordinaryFieldChangeRequired:true,independentAdbMetadataReadback:true,serverUrlReadiness});return;
    }
    if(command==='unpaired-ready'){
      stage='verify_unpaired_native_store';
      const value=await evaluate(`const p=app.plugins.plugins['obsync-private-sync'];if(!p?.state||p.state.paired||p.state.data.deviceId!==null||p.state.data.deviceSecret!==null||p.state.data.vrk!==null||p.state.custody2()!==null||p.state.secrets!==app.secretStorage)throw Error('fresh unpaired native store required');return {paired:false,nativeSecretStoreUnmodified:true,version:p.manifest.version};`);
      receipt({result:'PASS',...value});return;
    }
    if(command==='show-files'){
      stage='activate_owned_files_view';await evaluate(`const leaves=app.workspace.getLeavesOfType('file-explorer');if(leaves.length!==1)throw Error('one owned Files view required');await app.workspace.revealLeaf(leaves[0]);return true;`);receipt({result:'ACTION_COMPLETED',method:'public Obsidian Files view activation'});
    }else if(command==='inspect-file-controls'){
      stage='inspect_only_native_file_controls';
      const value=await evaluate(`const ids=['workspace:new-tab','file-explorer:new-file','file-explorer:new-folder','app:rename-file'];return {menus:[...document.querySelectorAll(".menu-item-title")].filter(e=>e.getClientRects().length).map(e=>e.textContent.trim()),commands:ids.map(id=>({id,exists:!!app.commands.commands[id],name:app.commands.commands[id]?.name??null})),explorerCoreEnabled:app.internalPlugins.plugins['file-explorer']?.enabled??null,explorerLeaves:app.workspace.getLeavesOfType('file-explorer').map(l=>({connected:l.view.containerEl.isConnected,classes:l.view.containerEl.className,sameDocument:l.view.containerEl.ownerDocument===document,elements:[...l.view.containerEl.querySelectorAll('*')].slice(0,60).map(e=>({tag:e.tagName,classes:e.className,role:e.getAttribute('role'),dataPath:e.getAttribute('data-path')})),buttons:[...l.view.containerEl.querySelectorAll('[aria-label]')].map(e=>({label:e.getAttribute('aria-label'),classes:e.className})),folderRows:[...l.view.containerEl.querySelectorAll('.nav-folder-title[data-path]')].map(e=>({path:e.getAttribute('data-path'),classes:e.className}))})),explorerPresent:!!document.querySelector('.nav-files-container'),explorerButtons:[...document.querySelectorAll('.nav-buttons-container [aria-label]')].slice(0,16).map(e=>({label:e.getAttribute('aria-label'),classes:e.className,visible:!!e.getClientRects().length})),folderRows:[...document.querySelectorAll('.nav-folder-title[data-path]')].slice(0,16).map(e=>({path:e.getAttribute('data-path'),classes:e.className,visible:!!e.getClientRects().length})),policyUnchanged:app.plugins.plugins['obsync-private-sync'].state.data.syncFolders};`);
      receipt({result:'OBSERVED',readOnly:true,...value});
    }else if(command==='folder-snapshot'||command==='folder-verify'){
      stage='independent_folder_and_descendant_bytes';
      if(!/^[A-Za-z][A-Za-z0-9 -]{0,63}$/.test(input.folder??'')||input.folder.trim()!==input.folder)throw Error('explicit synthetic root folder required');
      const folder=input.folder;
      const observed=await evaluate(`return await (${waitFolderIndex.toString()})(app,P.folder);`,{folder});
      const {rows:files,...facts}=observed;folderIndexReadiness=facts;
      if(observed.boundExceeded)throw Error('bounded synthetic folder required');
      if(!observed.ready)throw Error('native folder index deadline');
      device('shell','test','-d',androidPathArg(ownedVault(input.vaultPath)+'/'+folder));
      if(!readOwnedRootEntries(device,input.vaultPath).includes(folder))throw Error('exact persisted folder case differs');
      const rows=files.map(f=>{if(!f.path.startsWith(folder+'/')||!f.path.split('/').every(s=>/^[A-Za-z0-9][A-Za-z0-9 .-]*$/.test(s)))throw Error('unsafe synthetic descendant path');if(!/^[a-f0-9]{32}$/.test(f.id??''))throw Error('synced descendant identity required');const bytes=device('exec-out','cat',androidExecPathArg(input.vaultPath+'/'+f.path));return {suffix:f.path.slice(folder.length+1),bytes:bytes.length,sha256:digest(bytes),fileIdHash:digest(Buffer.from(f.id))};});
      if(command==='folder-snapshot'){
        if(resolve(input.output)!==join(run,'private',input.output.split('/').at(-1))||!/^folder-before-[A-Za-z0-9-]+\.json$/.test(input.output.split('/').at(-1)))throw Error('fixed private folder snapshot required');
        writeFileSync(input.output,JSON.stringify({sourceHead:state.sourceHead,folder,files:rows})+'\n',{mode:0o600,flag:'wx'});
      }else if(input.beforeSnapshot){
        const before=privateJson(input.beforeSnapshot);
        if(before.sourceHead!==state.sourceHead||before.folder!==input.oldFolder||!Array.isArray(before.files)||JSON.stringify([...before.files].sort((a,b)=>a.suffix.localeCompare(b.suffix)))!==JSON.stringify([...rows].sort((a,b)=>a.suffix.localeCompare(b.suffix))))throw Error('renamed descendant identities or bytes differ');
        if(readOwnedRootEntries(device,input.vaultPath).includes(input.oldFolder))throw Error('old exact folder name remains persisted');
        await evaluate(`if(app.vault.getAbstractFileByPath(P.oldFolder))throw Error('old folder remains indexed');return true;`,{oldFolder:input.oldFolder});
      }
      receipt({result:'PASS',folder,descendants:rows.length,independentAdbBytes:true,descendantIdentityAndBytesPreserved:!!input.beforeSnapshot,syncClaim:false,folderIndexReadiness});
    }else if(['history-baseline','history-open','history-previous','history-pick','history-readback'].includes(command)){
      const historyDom=`const visible=e=>!!e&&e.getBoundingClientRect().width>0&&e.getBoundingClientRect().height>0;const ms=[...document.querySelectorAll('.modal:not(.mod-settings)')].filter(visible);if(ms.length!==1||ms[0].querySelector('.modal-title')?.textContent.trim()!=='Restore from history')throw Error('sole ordinary history modal required');const modal=ms[0];`;
      if(command==='history-baseline'){
        stage='snapshot_current_note_before_history_action';syntheticNotePath(input.note);
        const bytes=device('exec-out','cat',androidExecPathArg(ownedVault(input.vaultPath)+'/'+input.note));
        if(!bytes.equals(Buffer.from(input.text)))throw Error('retained fixture current bytes differ');
        const before=await evaluate(`const paths=app.vault.getMarkdownFiles().map(f=>f.path).sort(),r=app.plugins.plugins['obsync-private-sync'].state.fileByPath(P.note);if(paths.length>32||!/^[a-f0-9]{32}$/.test(r?.fileId??''))throw Error('bounded tracked history fixture required');return {paths,sourceId:r.fileId};`,{note:input.note});
        writeFileSync(join(run,'private','android-history-before.json'),JSON.stringify({sourceHead:state.sourceHead,note:input.note,sha256:digest(bytes),...before})+'\n',{mode:0o600,flag:'wx'});
        receipt({result:'PASS',independentOriginalBytes:true,originalSha256:digest(bytes),nativeNoteCount:before.paths.length});
      }else if(command==='history-open'){
        stage='open_ordinary_restore_from_history';await evaluate(`app.setting.close();if(app.commands.executeCommandById('obsync-private-sync:restore-history')===false)throw Error('ordinary history command unavailable');return true;`);
        receipt({result:'ACTION_COMPLETED',method:'public Obsidian Restore from history command'});
      }else if(command==='history-previous'){
        stage='choose_explicit_previous_generation_ui';
        const point=await evaluate(historyDom+`const rows=[...modal.querySelectorAll('.setting-item')].filter(e=>visible(e)&&e.querySelector('.setting-item-name')?.textContent.trim()==='Previous generation');if(rows.length!==1)throw Error('sole Previous generation control required');const ts=[...rows[0].querySelectorAll('.checkbox-container')].filter(visible);if(ts.length!==1||ts[0].classList.contains('is-enabled')||ts[0].classList.contains('is-disabled')||ts[0].getAttribute('aria-disabled')==='true')throw Error('disabled previous generation choice required');return (${pointerTarget.toString()})(ts[0],(${pointerObservation.toString()}));`);
        await send('Input.dispatchMouseEvent',{type:'mousePressed',x:point.x,y:point.y,button:'left',clickCount:1});await send('Input.dispatchMouseEvent',{type:'mouseReleased',x:point.x,y:point.y,button:'left',clickCount:1});
        await evaluate(historyDom+`if(![...modal.querySelectorAll('p')].some(e=>e.textContent.startsWith('Previous generation: retained migrated heads and their ancestors')))throw Error('explicit previous generation banner absent');return true;`);
        receipt({result:'PASS',method:'ordinary Previous generation toggle with trusted pointer',explicitPreviousGenerationBanner:true});
      }else if(command==='history-pick'){
        stage='restore_unique_visible_retained_note';
        const bytes=Buffer.byteLength(input.text);
        const selected=await evaluate(historyDom+`if(![...modal.querySelectorAll('p')].some(e=>e.textContent.startsWith('Previous generation: retained migrated heads and their ancestors')))throw Error('explicit previous generation banner absent');const end=Date.now()+20000;while(Date.now()<end){const rows=[...modal.querySelectorAll('.setting-item')].filter(e=>visible(e)&&e.querySelector('.setting-item-name')?.textContent.trim()===P.note&&e.querySelector('.setting-item-description')?.textContent.includes(' · '+P.bytes+' B · Creates a new file beside this historical path'));const buttons=rows.flatMap(r=>[...r.querySelectorAll('button')].filter(b=>visible(b)&&!b.disabled&&b.textContent.trim()==='Restore a copy'));if(buttons.length>1)throw Error('retained history version ambiguous');if(buttons.length===1){return (${pointerTarget.toString()})(buttons[0],(${pointerObservation.toString()}));}await new Promise(r=>setTimeout(r,100));}throw Error('known retained history row deadline');`,{note:input.note,bytes});
        await send('Input.dispatchMouseEvent',{type:'mousePressed',x:selected.x,y:selected.y,button:'left',clickCount:1});await send('Input.dispatchMouseEvent',{type:'mouseReleased',x:selected.x,y:selected.y,button:'left',clickCount:1});
        receipt({result:'ACTION_COMPLETED',ordinaryRestoreCopy:true,uniqueVisibleRetainedNoteAndSize:true});
      }else{
        stage='independent_restored_copy_bytes_before_editor';
        const before=privateJson(join(run,'private','android-history-before.json'));
        if(before.sourceHead!==state.sourceHead||before.note!==input.note||before.sha256!==digest(Buffer.from(input.text))||!Array.isArray(before.paths))throw Error('prior owned history baseline required');
        const restored=await evaluate(`const end=Date.now()+20000;while(Date.now()<end){const paths=app.vault.getMarkdownFiles().map(f=>f.path),added=paths.filter(p=>!P.paths.includes(p));if(added.length>1)throw Error('history restore created unexpected siblings');if(added.length===1&&![...document.querySelectorAll('.modal:not(.mod-settings)')].some(m=>m.getClientRects().length)){if(!(${restoredSiblingPath.toString()})(P.note,added[0]))throw Error('history sibling path differs');return added[0];}await new Promise(r=>setTimeout(r,100));}throw Error('ordinary history restored copy deadline');`,{paths:before.paths,note:input.note});
        const original=device('exec-out','cat',androidExecPathArg(ownedVault(input.vaultPath)+'/'+input.note)),copy=device('exec-out','cat',androidExecPathArg(input.vaultPath+'/'+restored));
        if(digest(original)!==before.sha256||!copy.equals(Buffer.from(input.text)))throw Error('restored history or original persisted bytes differ');
        await evaluate(`const p=app.plugins.plugins['obsync-private-sync'];if(p.state.fileByPath(P.original)?.fileId!==P.originalId)throw Error('history restore changed original identity');const file=app.vault.getFileByPath(P.restored);if(!file)throw Error('native restored copy index absent');await app.workspace.getLeaf(false).openFile(file);if(app.workspace.getMostRecentLeaf().view.editor?.getValue()!==P.text)throw Error('restored history editor bytes differ');return true;`,{original:input.note,originalId:before.sourceId,restored,text:input.text});
        writeFileSync(join(run,'private','android-history-restored.json'),JSON.stringify({sourceHead:state.sourceHead,path:restored,text:input.text,sha256:digest(copy)})+'\n',{mode:0o600,flag:'wx'});
        receipt({result:'PASS',independentAdbBytesBeforeEditor:true,knownRetainedBytesMatch:true,originalBytesAndIdentityUnchanged:true,nativeRestoredEditorMatches:true,newSiblingCount:1,bytes:copy.length,sha256:digest(copy)});
      }
    }else if(command==='selected-boundaries'){
      stage='verify_native_selected_folder_boundaries';
      if(!['Team docs','team docs'].includes(input.folder)||input.outsideLocal!=='Outside/Phone-sentinel.md'||input.outsideAbsent!=='Outside/Sentinel.md'||typeof input.outsideText!=='string'||input.outsideText.length<16||input.outsideText.length>4096)throw Error('explicit selected boundary fixtures required');
      const vault=ownedVault(input.vaultPath),names=readOwnedRootEntries(device,vault);
      const exactFolderCount=names.filter(n=>n.toLowerCase()==='team docs').length;
      const bytes=device('exec-out','cat',androidExecPathArg(vault+'/'+input.outsideLocal));
      let foreignAbsent=true;
      try{device('shell','test','!','-e',androidPathArg(vault+'/'+input.outsideAbsent));}catch(error){if(error.status===1&&!error.stderr?.length)foreignAbsent=false;else throw error;}
      const trashPath=androidPathArg(vault+'/.trash');
      const trash=device('shell',`if test ! -e ${trashPath}; then echo OBSYNC_TRASH_ABSENT; elif test -d ${trashPath}; then find ${trashPath} -mindepth 1 -maxdepth 2; else echo OBSYNC_TRASH_NOT_DIRECTORY; fi`).toString().trim();
      const trashEntries=trash==='OBSYNC_TRASH_ABSENT'||trash===''?0:trash.split('\n').length;
      const native=await evaluate(`const p=app.plugins.plugins['obsync-private-sync'];return {savedPolicyMatched:JSON.stringify(p.state.data.syncFolders)===JSON.stringify([P.folder]),folderIndexed:!!app.vault.getAbstractFileByPath(P.folder),localOutsideIndexed:!!app.vault.getFileByPath(P.local),localOutsideUntracked:!p.state.fileByPath(P.local),foreignOutsideIndexAbsent:!app.vault.getAbstractFileByPath(P.absent)};`,{folder:input.folder,local:input.outsideLocal,absent:input.outsideAbsent});
      const facts={exactPersistedFolderCase:names.includes(input.folder)&&exactFolderCount===1,foldedFolderCount:exactFolderCount,localExcludedBytesPreserved:bytes.equals(Buffer.from(input.outsideText)),foreignExcludedAdbAbsent:foreignAbsent,trashEmpty:trashEntries===0,trashEntries,...native};
      const passed=facts.exactPersistedFolderCase&&facts.localExcludedBytesPreserved&&facts.foreignExcludedAdbAbsent&&facts.trashEmpty&&Object.values(native).every(v=>v===true);
      receipt({result:passed?'PASS':'FAIL',readOnly:true,independentAdbReadback:true,...facts});if(!passed)process.exitCode=1;
    }else if(command==='fixture-provision'){
      stage='provision_explicit_excluded_synthetic_fixture';
      if(input.path!=='Outside/Phone-sentinel.md'||typeof input.text!=='string'||input.text.length<16||input.text.length>4096)throw Error('explicit outside phone fixture required');
      await evaluate(`const p=app.plugins.plugins['obsync-private-sync'];if(!Array.isArray(p.state.data.syncFolders)||!p.state.data.syncFolders.length||p.state.data.syncFolders.some(f=>'Outside'===f||'Outside'.startsWith(f+'/')))throw Error('saved selected policy must exclude Outside');if(app.vault.getAbstractFileByPath(P.path))throw Error('fresh phone fixture destination required');const folder=app.vault.getAbstractFileByPath('Outside');if(folder&&!Array.isArray(folder.children))throw Error('Outside folder name occupied');if(!folder)await app.vault.createFolder('Outside');await app.vault.create(P.path,P.text);return true;`,{path:input.path,text:input.text});
      const bytes=device('exec-out','cat',ownedVault(input.vaultPath)+'/'+input.path);
      if(!bytes.equals(Buffer.from(input.text)))throw Error('independent Android persisted bytes differ');
      await evaluate(`if(app.plugins.plugins['obsync-private-sync'].state.fileByPath(P.path))throw Error('excluded fixture unexpectedly tracked');return true;`,{path:input.path});
      receipt({result:'PASS',method:'public native Vault createFolder/create synthetic fixture provisioning',ordinaryUserAction:false,independentAdbBytes:true,bytes:bytes.length,sha256:digest(bytes),syncIdentityAbsent:true});
    }else if(command==='rotation-pair-status'){
      stage='verify_replacement_enrollment_and_history';
      if(!/^[a-f0-9]{64}$/.test(input.expectedGenerationHash??'')||!/^[a-f0-9]{64}$/.test(input.expectedOldGenerationHash??'')||input.expectedGenerationHash===input.expectedOldGenerationHash)throw Error('independent distinct rotation generation hashes required');
      replacementReadiness={polls:0,deadlineMs:20000};
      await waitRotationPair(async budget=>await evaluate(`return await (${rotationPairObservation.toString()})(app,P);`,{current:input.expectedGenerationHash,old:input.expectedOldGenerationHash},true,budget),replacementReadiness);
      if(replacementReadiness.refused)throw Error('replacement generation or retained history differs');
      if(!replacementReadiness.ready)throw Error('replacement enrollment deadline');
      receipt({result:'PASS',paired:true,suite:2,phase:'active',historySuite:2,historyGenerationMatched:true,currentGenerationMatched:true,replacementReadiness,readOnly:true});
    }else if(command==='new-tab'){
      await evaluate(`if(app.commands.executeCommandById('workspace:new-tab')===false)throw Error('public New tab command unavailable');return true;`);receipt({result:'ACTION_COMPLETED',method:'public Obsidian New tab command'});
    }else if(command==='close-settings'){
      await evaluate(`app.setting.close();return true;`);
      const closed=await evaluate(`const read=()=>[...document.querySelectorAll('.modal.mod-settings')].filter(e=>e.getBoundingClientRect().width>0&&e.getBoundingClientRect().height>0).length,before=read(),end=Date.now()+10000;let after=before,polls=1;while(after>0&&Date.now()<end){await new Promise(r=>setTimeout(r,100));after=read();polls++;}return {beforeVisibleSettingsCount:before,afterVisibleSettingsCount:after,polls,settingsClosed:after===0};`);
      if(!closed.settingsClosed)throw Error('ordinary Settings close deadline');
      receipt({result:'ACTION_COMPLETED',method:'public Obsidian Settings close with passive native modal disappearance',...closed});
    } else if (command === 'tls-probe') {
      const target=new URL(input.url);
      if(target.protocol!=='https:'||!['localhost','127.0.0.1'].includes(target.hostname)||!state.reversePorts.includes(Number(target.port))||!['/readyz','/v1/plugin/manifest'].includes(target.pathname)||target.search||target.hash||target.username||target.password||!['untrusted','trusted','wrong-host'].includes(input.case))throw Error('owned local TLS probe required');
      await send('Network.enable');
      const probeStartedAt=new Date().toISOString();
      const outcome = await evaluate(`const facts={appOriginUsesLocalhost:location.hostname==='localhost',fetchNative:fetch.toString().includes('[native code]')};try{const r=await fetch(P.url,{cache:'no-store',signal:AbortSignal.timeout(10000)});const body=await r.json();return {...facts,resolved:true,status:r.status,manifestVersion:typeof body.version==='string'?body.version:null};}catch(e){return {...facts,resolved:false,errorName:e.name};}`, { url: input.url }, false);
      const probeEndedAt=new Date().toISOString();
      await new Promise(resolveWait=>setTimeout(resolveWait,300));
      const expected = input.case === 'untrusted' ? 'net::ERR_CERT_AUTHORITY_INVALID' : input.case === 'wrong-host' ? 'net::ERR_CERT_COMMON_NAME_INVALID' : null;
      const pass = input.case === 'trusted' ? outcome.resolved && outcome.status === 200 : !outcome.resolved && networkFailures.includes(expected);
      receipt({ result: pass ? 'PASS' : 'FAIL', case: input.case, appPid,probeStartedAt,probeEndedAt,diagnosticOnly: true, route:input.url.endsWith('/manifest')?'public plugin manifest':'readiness',manifestVersion:outcome.manifestVersion??null,appOriginUsesLocalhost:outcome.appOriginUsesLocalhost,fetchNative:outcome.fetchNative,errorName:outcome.errorName??null,webViewFetchResolved: outcome.resolved, status: outcome.status ?? null, expectedCertificateErrorObserved: expected ? networkFailures.includes(expected) : null, networkErrors: networkFailures.filter(e=>/^net::ERR_[A-Z_]+$/.test(e)), blockedReasons, tlsVerificationDisabled: false });
      if (!pass) process.exitCode = 1;
    } else if (command === 'inspect') {
      stage='inspect_owned_webview';
      const result = await evaluate(`const visible=e=>!!e.getClientRects().length;const p=window.app?.plugins?.plugins?.['obsync-private-sync'];const privateDialog=!!document.querySelector('.obsync-code,.obsync-phrase,.modal:not(.mod-settings)')||[...document.querySelectorAll('input[type=password],textarea')].some(e=>e.value);return {appReady:!!window.app,dialogTitles:[...document.querySelectorAll('.modal:not(.mod-settings) .modal-title')].filter(visible).map(e=>e.textContent.trim()),comparisonCounts:(()=>{const x=(${visibleComparisons.toString()})();return {creator:x.creator.length,claimant:x.claimant.length};})(),ownedVault:P.vaultPath?window.app?.vault?.adapter?.basePath===P.vaultPath:null,pluginLoaded:!!p,paired:p?.state?.paired??null,buttons:[...document.querySelectorAll('button')].filter(visible).map(e=>({text:e.textContent.trim().slice(0,90),disabled:e.disabled})),inputs:[...document.querySelectorAll('input')].filter(visible).map(e=>({placeholder:e.placeholder,type:e.type,classes:e.className,checked:e.checked,valueLength:e.value.length})),actions:[...document.querySelectorAll('.empty-state-action,.inline-title,[aria-label]')].filter(visible).slice(0,40).map(e=>({tag:e.tagName,classes:e.className,label:e.getAttribute('aria-label'),text:e.classList.contains('inline-title')?'OMITTED':e.textContent.trim().slice(0,80)})),onboardingStorage:!window.app?[...document.querySelectorAll('[class*=mobile-onboarding-radio]')].filter(visible).map(e=>({tag:e.tagName,classes:e.className,role:e.getAttribute('role'),text:e.textContent.trim()})):[],text:privateDialog||p?.state?.paired?'OMITTED_PRIVATE_OR_PAIRED':document.body.innerText.replace(/https?:\\S+/g,'<url>').slice(0,1800)};`, input, false);
      receipt({ result: 'OBSERVED', ...result });
    } else if (command === 'control' || command === 'type') {
      stage='locate_ordinary_control';
      if (typeof input.selector !== 'string' || input.selector.length > 500 || !['click', 'focus','contextmenu'].includes(input.action ?? 'focus')) throw Error('observed exact selector required');
      controlReadiness=await evaluate(`const visible=e=>e.getBoundingClientRect().width>0&&e.getBoundingClientRect().height>0;const knownTitles=new Set(['Pair this device','Pair after a key rotation','Do you trust the author of this vault?','Set up or recover','Pair and upload']);const read=()=>{const es=[...document.querySelectorAll(P.selector)].filter(visible).filter(e=>P.expectedText==null||e.textContent.trim()===P.expectedText),modals=[...document.querySelectorAll('.modal:not(.mod-settings)')].filter(visible),url=document.querySelector('input[placeholder="sync.example.org"]'),p=window.app?.plugins?.plugins?.['obsync-private-sync'];return {matchingVisibleControls:es.length,uniqueControlEnabled:es.length===1&&!es[0].disabled,visibleModalCount:modals.length,knownModalTitles:modals.map(m=>{const t=m.querySelector('.modal-title')?.textContent.trim();return knownTitles.has(t)?t:'OTHER';}),visibleModalInputCount:modals.reduce((n,m)=>n+[...m.querySelectorAll('input')].filter(visible).length,0),focusedFieldIsServerUrl:!!url&&document.activeElement===url,urlFieldMatchesAdoptedState:!!url&&url.value===p?.state?.data?.serverUrl,paired:p?.state?.paired??null};};const before=read(),end=Date.now()+10000;let after=before,polls=1;while(!after.uniqueControlEnabled&&after.matchingVisibleControls<2&&Date.now()<end){await new Promise(r=>setTimeout(r,100));after=read();polls++;}return {before,after,polls,ready:after.uniqueControlEnabled};`,{selector:input.selector,expectedText:input.expectedText},input.onboarding!==true);
      if(controlReadiness.after.matchingVisibleControls>1)throw Error('ordinary control absent or ambiguous');
      if(!controlReadiness.ready)throw Error('ordinary control readiness deadline');
      let result;
      if(command==='control'&&['click','contextmenu'].includes(input.action)){
        stage='wait_exact_ordinary_pointer_target';
        pointerReadiness=await evaluate(`const read=()=>(${ordinaryControl.toString()})(P.selector,'locate',P.expectedText??null,(${pointerObservation.toString()}));return await (${waitPointerReadiness.toString()})(read);`,{selector:input.selector,expectedText:input.expectedText},input.onboarding!==true);
        if(!pointerReadiness.ready)throw Error('ordinary pointer target readiness deadline');result=pointerReadiness;
      }else result=await evaluate(`return (${ordinaryControl.toString()})(P.selector,'focus',P.expectedText??null,(${pointerTarget.toString()}));`,{selector:input.selector,expectedText:input.expectedText},input.onboarding!==true);
      if(command==='control'&&['click','contextmenu'].includes(input.action)){
        const button=input.action==='contextmenu'?'right':'left';
        if(button==='left')await trustedPointerClick({selector:input.selector,expectedText:input.expectedText,point:result},input.onboarding!==true);
        else{await send('Input.dispatchMouseEvent',{type:'mousePressed',x:result.x,y:result.y,button,clickCount:1});await send('Input.dispatchMouseEvent',{type:'mouseReleased',x:result.x,y:result.y,button,clickCount:1});}
      }
      if (command === 'type') {
        stage='trusted_input_and_native_readback';
        if (typeof input.text !== 'string' || input.text.length > 65536) throw Error('bounded private text required');
        await evaluate(`window.obsyncJourneyInput=null;document.addEventListener('beforeinput',e=>window.obsyncJourneyInput={trusted:e.isTrusted}, {capture:true,once:true});return true;`,{},input.onboarding!==true);
        if(input.selectAll===true)await evaluate(`return (${selectAllText.toString()})();`,{},input.onboarding!==true);
        await send('Input.insertText', { text: input.text });
        const matched=await evaluate(`const e=document.activeElement;const matches=P.note?app.workspace.activeLeaf?.view?.file?.path===P.note&&app.workspace.activeLeaf.view.editor.getValue()===P.text:typeof e?.value==='string'?e.value===P.text:e?.isContentEditable&&e.textContent.includes(P.text);const trusted=window.obsyncJourneyInput?.trusted===true;delete window.obsyncJourneyInput;return {matches,trusted};`,{text:input.text,note:input.note},input.onboarding!==true);
        if(!matched.matches||!matched.trusted)throw Error('typed native field readback or trusted input differs');
        if(input.pressEnter===true){await send('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});await send('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});}
        if(input.pressTab===true){await send('Input.dispatchKeyEvent',{type:'keyDown',key:'Tab',code:'Tab',windowsVirtualKeyCode:9});await send('Input.dispatchKeyEvent',{type:'keyUp',key:'Tab',code:'Tab',windowsVirtualKeyCode:9});}
      }
      receipt({ result: 'ACTION_COMPLETED', matchingVisibleControls:result.matchingVisibleControls,pointerViewportMatched:result.pointerViewportMatched,pointerHitTargetMatched:result.pointerHitTargetMatched,pointerReadiness,pointerWitness,controlReadiness,method:command==='control'&&['click','contextmenu'].includes(input.action)?'CDP Input.dispatchMouseEvent ordinary-control '+input.action:result.method, inputMethod: command === 'type' ? 'CDP Input.insertText' : null });
    } else if (command === 'install') {
      stage='install_owned_vault_path';const vault=ownedVault(input.vaultPath);
      stage='install_source_realpath';const source=realpathSync(input.sourceDir);
      stage='install_private_preflight';const preflight=privateJson(input.preflight);
      stage='install_preflight_binding';if(preflight.sourceHead!==state.sourceHead||!preflight.sourceClean)throw Error('clean matching source required');
      stage='install_git_head';if(execFileSync('git',['-C',source,'rev-parse','HEAD'],{encoding:'utf8'}).trim()!==state.sourceHead)throw Error('clean matching source required');
      stage='install_git_clean';if(execFileSync('git',['-C',source,'status','--porcelain'],{encoding:'utf8'}).trim())throw Error('clean matching source required');
      stage='install_wait_native_app_plugin_registry';await readyNativeStartup();
      stage='install_native_plugin_absent';
      await evaluate(`if(app.plugins.plugins['obsync-private-sync'])throw Error('disable plugin before installation');return true;`);
      const destination = vault + '/.obsidian/plugins/obsync-private-sync', installed = {};installReadbacks=[];
      stage='install_destination_absent';
      try { device('shell', 'test', '!', '-e', destination); } catch { throw Error('fresh plugin destination required'); }
      stage='install_destination_mkdir';
      device('shell', 'mkdir', '-p', destination);
      for (const name of ['main.js', 'manifest.json', 'styles.css']) {
        stage='install_asset_source_'+name.replace('.','_');
        const file = join(source, 'plugin/dist', name), stat = lstatSync(file), expected = preflight.pluginHashes[name];
        if (!stat.isFile() || stat.isSymbolicLink() || !/^[a-f0-9]{64}$/.test(expected)) throw Error('candidate bytes differ');
        const sourceBytes=readFileSync(file);
        if (digest(sourceBytes) !== expected) throw Error('candidate bytes differ');
        stage='install_asset_push_'+name.replace('.','_');
        device('push', file, destination + '/' + name);
        stage='install_asset_adb_readback_'+name.replace('.','_');
        const readback={asset:name,method:'single-raw-exec-out-cat',before:installProcessFacts(),...persistedByteFacts(sourceBytes,undefined),readAttempts:1};installReadbacks.push(readback);
        const observed=device('exec-out', 'cat', destination + '/' + name);
        Object.assign(readback,persistedByteFacts(sourceBytes,observed),{after:installProcessFacts(),sourceStillPinned:digest(readFileSync(file))===expected});
        if (!readback.exactBytesMatched) {
          // Independent diagnostics only: this mismatch remains terminal even
          // if remote storage matches. Never retry the raw read to get a pass.
          const end=Date.now()+4000,remaining=()=>end-Date.now();
          try{const bytes=deviceBudget(remaining(),'shell','toybox','stat','-c','%s',destination+'/'+name).toString().trim(),hash=deviceBudget(remaining(),'shell','toybox','sha256sum',destination+'/'+name).toString().trim().split(/\s+/);if(!/^\d+$/.test(bytes)||hash.length!==2||!/^[a-f0-9]{64}$/.test(hash[0])||hash[1]!==destination+'/'+name)throw Error('public asset witness invalid');readback.remoteStorage={bytes:Number(bytes),sha256:hash[0]};}catch(error){readback.remoteStorage={result:'UNAVAILABLE',...externalFailure(error)};}
          if(Date.now()<end)try{const value=deviceBudget(remaining(),'get-state').toString().trim();readback.transportState=['device','offline','unknown'].includes(value)?value:'OTHER';}catch(error){readback.transportState='UNAVAILABLE';readback.transportFailure=externalFailure(error);}
          if(Date.now()<end)try{const value=deviceBudget(remaining(),'shell','pidof','md.obsidian').toString().trim();readback.appPidMatches=/^\d+$/.test(value)&&Number(value)===connectReadiness?.appPid;}catch(error){readback.appPidMatches=null;readback.appPidFailure=externalFailure(error);}
          throw Error('independent installed bytes differ');
        }
        if(!readback.sourceStillPinned)throw Error('candidate bytes differ');
        installed[name] = readback.observedSha256;
      }
      receipt({ result: 'PASS', installedAssetHashes: installed,installReadbacks,startupReadiness,independentAdbReadback: true, metadataOrCredentialsSeeded: false });
    } else if (command === 'settings') {
      if (!['community-plugins', 'obsync-private-sync'].includes(input.tab)) throw Error('explicit owned plugin settings required');
      await evaluate(`app.setting.open();app.setting.openTabById(P.tab);return true;`, { tab: input.tab });
      receipt({ result: 'ACTION_COMPLETED', method: 'public Obsidian Settings open' });
    }else if(command==='community-trust-choice'){
      stage='classify_exact_fresh_native_trust_entry';
      const entry=await evaluate(`const visible=e=>!!e&&e.getBoundingClientRect().width>0&&e.getBoundingClientRect().height>0;const read=()=>{const plugins=app.plugins,modals=[...document.querySelectorAll('.modal.mod-trust-folder')].filter(visible),modal=modals[0],buttons=modal?[...modal.querySelectorAll('button')].filter(visible):[];return {candidateManifest:plugins?.manifests?.['obsync-private-sync']?.id==='obsync-private-sync',candidateLoaded:!!plugins?.plugins?.['obsync-private-sync'],communityPluginsEnabled:plugins?.isEnabled?.()===true,trustModalCount:modals.length,trustTitleMatched:modal?.querySelector('.modal-title')?.textContent.trim()==='Do you trust the author of this vault?',trustButtons:buttons.filter(e=>e.textContent.trim()==='Trust author and enable plugins').length,restrictedButtons:buttons.filter(e=>e.textContent.trim()==='Browse vault in Restricted Mode').length,otherModalCount:[...document.querySelectorAll('.modal:not(.mod-settings):not(.mod-trust-folder)')].filter(visible).length,layoutReady:app.workspace?.layoutReady===true};};const before=read(),end=Date.now()+20000;let after=before,polls=1,route=(${freshTrustRoute.toString()})(after);while(!route&&Date.now()<end){await new Promise(r=>setTimeout(r,100));after=read();polls++;route=(${freshTrustRoute.toString()})(after);}return {before,after,polls,route};`);
      communityTrustReadiness={freshEntry:entry};
      if(!entry.route)throw Error('fresh native trust entry deadline');
      const prompt=entry.route==='INITIAL_TRUST_MODAL';
      if(!prompt)await evaluate(`app.setting.open();app.setting.openTabById('community-plugins');return true;`);
      stage='wait_exact_native_trust_consent_pointer';
      await evaluate(`const visible=e=>e.getBoundingClientRect().width>0&&e.getBoundingClientRect().height>0;const end=Date.now()+10000;while(Date.now()<end){const es=[...document.querySelectorAll(P.selector)].filter(visible).filter(e=>e.textContent.trim()===P.text);if(es.length>1)throw Error('ordinary control absent or ambiguous');if(es.length===1&&!es[0].disabled)return true;await new Promise(r=>setTimeout(r,100));}throw Error('ordinary control readiness deadline');`,{selector:prompt?'.modal.mod-trust-folder button':'.modal.mod-settings button',text:prompt?'Trust author and enable plugins':'Exit Restricted mode'});
      pointerReadiness=await evaluate(`const read=()=>{if(app.plugins?.plugins?.['obsync-private-sync']||app.plugins?.isEnabled?.())throw Error('fresh native trust entry refused');const modals=[...document.querySelectorAll('.modal.mod-trust-folder')].filter(e=>e.getBoundingClientRect().width>0&&e.getBoundingClientRect().height>0);if(P.prompt){if(modals.length!==1||modals[0].querySelector('.modal-title')?.textContent.trim()!=='Do you trust the author of this vault?')throw Error('official native trust prompt changed');}else if(modals.length||app.setting?.activeTab?.id!=='community-plugins')throw Error('official restricted settings changed');return (${ordinaryControl.toString()})(P.selector,'locate',P.text,(${pointerObservation.toString()}));};return await (${waitPointerReadiness.toString()})(read);`,{prompt,selector:prompt?'.modal.mod-trust-folder button':'.modal.mod-settings button',text:prompt?'Trust author and enable plugins':'Exit Restricted mode'});
      if(!pointerReadiness.ready)throw Error('ordinary pointer target readiness deadline');
      stage='ordinary_known_candidate_trust_consent';
      await send('Input.dispatchMouseEvent',{type:'mousePressed',x:pointerReadiness.x,y:pointerReadiness.y,button:'left',clickCount:1});
      await send('Input.dispatchMouseEvent',{type:'mouseReleased',x:pointerReadiness.x,y:pointerReadiness.y,button:'left',clickCount:1});
      receipt({result:'ACTION_COMPLETED',method:'one trusted pointer click on source-classified official native trust control',route:entry.route,freshCandidateOnly:true,communityTrustReadiness,pointerReadiness});
    } else if(command==='community-trust-ready'||command==='community-trust-observe'){
      stage='observe_native_community_plugin_trust';
      communityTrustReadiness=await evaluate(`const read=()=>{const plugins=app.plugins;if(plugins?.plugins?.['obsync-private-sync']?.state?.paired)throw Error('unpaired official plugin diagnostic required');const visible=e=>!!e&&e.getBoundingClientRect().width>0&&e.getBoundingClientRect().height>0;const enabledApiAvailable=typeof plugins?.isEnabled==='function',communityPluginsEnabled=enabledApiAvailable?plugins.isEnabled()===true:false,exitButtons=[...document.querySelectorAll('button')].filter(e=>visible(e)&&e.textContent.trim()==='Exit Restricted mode');const labels=[...document.querySelectorAll('.setting-item-name,h2,h3')].filter(visible).map(e=>e.textContent.trim());return {enabledApiAvailable,communityPluginsEnabled,restrictedExitButtonCount:exitButtons.length,restrictedAllowLabel:labels.includes('Allow community plugins'),normalRestrictedModeLabel:labels.includes('Restricted mode'),normalInstalledPluginsLabel:labels.includes('Installed plugins'),officialTabActive:app.setting?.activeTab?.id==='community-plugins',layoutReady:app.workspace?.layoutReady===true};};const acceptable=f=>P.fresh?f.enabledApiAvailable&&!f.communityPluginsEnabled&&f.restrictedExitButtonCount===1&&f.officialTabActive&&f.layoutReady:f.enabledApiAvailable&&f.communityPluginsEnabled&&f.restrictedExitButtonCount===0&&f.layoutReady;const waiting=P.wait||P.fresh,before=read(),end=Date.now()+(waiting?20000:0);let after=before,polls=1;while(waiting&&!acceptable(after)&&Date.now()<end){await new Promise(r=>setTimeout(r,100));after=read();polls++;}return {before,after,polls,ready:acceptable(after)};`,{wait:command==='community-trust-ready',fresh:input.expectedEnabled===false});
      if(command==='community-trust-ready'&&!communityTrustReadiness.ready)throw Error('ordinary community plugin trust completion deadline');
      if(input.expectedEnabled===false&&!communityTrustReadiness.ready)throw Error('fresh restricted community mode readiness deadline');
      receipt({result:command==='community-trust-ready'?'PASS':'OBSERVED',readOnly:true,communityTrustReadiness,trustChangedThroughOrdinaryUiOnly:true});
    } else if(command==='enable-diagnostic'){
      stage='read_only_official_plugin_tab_structure';
      const facts=await evaluate(`if(app.plugins?.plugins?.['obsync-private-sync']?.state?.paired)throw Error('unpaired official plugin diagnostic required');const manifest=app.plugins?.manifests?.['obsync-private-sync'],tab=app.setting?.activeTab,root=tab?.containerEl;const visible=e=>!!e&&e.getBoundingClientRect().width>0&&e.getBoundingClientRect().height>0;const classes=e=>typeof e.className==='string'?e.className:'NON_HTML';const describe=(container)=>{if(!container)return {present:false};const rows=[...container.querySelectorAll('.setting-item')],named=manifest?rows.filter(e=>e.textContent.includes(manifest.name)):[];const matched=manifest?[...container.querySelectorAll('.setting-item,[class*="plugin"]')].filter(e=>e.textContent.includes(manifest.name)).slice(0,20):[];return {present:true,connected:container.isConnected,sameDocument:container.ownerDocument===document,sameWindow:container.ownerDocument?.defaultView===window,tag:container.tagName,classes:classes(container),visible:visible(container),settingRows:rows.length,visibleSettingRows:rows.filter(visible).length,allRowsContainingCandidate:named.length,visibleRowsContainingCandidate:named.filter(visible).length,allCheckboxes:container.querySelectorAll('.checkbox-container').length,candidateElements:matched.map(e=>({tag:e.tagName,classes:classes(e),visible:visible(e),checkboxes:e.querySelectorAll('.checkbox-container').length,childClasses:[...e.children].slice(0,8).map(classes),settingName:e.querySelector('.setting-item-name')?.textContent.trim().slice(0,100)??null})),labels:[...container.querySelectorAll('h1,h2,h3,.setting-item-name,.community-plugin-name,.community-plugin-title')].slice(0,40).map(e=>({tag:e.tagName,classes:classes(e),visible:visible(e),label:e.textContent.trim().slice(0,120)}))};};return {manifestPresent:!!manifest,candidateManifest:manifest?{name:manifest.name,version:manifest.version}:null,officialTabIdMatches:tab?.id==='community-plugins',activeContainer:describe(root),currentDocument:describe(document.body),activeOwnerDocument:root?.ownerDocument===document?{same:true}:describe(root?.ownerDocument?.body)};`);
      receipt({result:'OBSERVED',readOnly:true,pairedDomExported:false,...facts});
    } else if(command==='enable'){
      stage='wait_official_community_candidate_control';
      enableReadiness=await evaluate(`const read=()=>(${candidateControlRead.toString()})((${candidateLabelMatches.toString()}));return await (${waitCandidateReadiness.toString()})(read);`);      if(enableReadiness.after.nameRows>1||enableReadiness.after.versionRows>1||enableReadiness.after.toggleCount>1)throw Error('candidate control ambiguous');
      if(enableReadiness.after.candidateAlreadyLoaded)throw Error('one disabled installed candidate required');
      if(enableReadiness.after.toggleEnabled)throw Error('disabled ordinary toggle required');
      if(!enableReadiness.ready)throw Error('official candidate control readiness deadline');
      stage='wait_revalidated_candidate_pointer';
      enableReadiness.pointerReadiness=await evaluate(`const readPointer=()=>{const next=(${candidateControlRead.toString()})((${candidateLabelMatches.toString()}));if(next.refused||!next.ready)throw Error('candidate changed before ordinary enable');return (${pointerObservation.toString()})(next.toggle);};return await (${waitPointerReadiness.toString()})(readPointer);`);
      if(!enableReadiness.pointerReadiness?.ready)throw Error('candidate pointer target readiness deadline');
      const point=enableReadiness.point={x:enableReadiness.pointerReadiness.x,y:enableReadiness.pointerReadiness.y};
      stage='enable_exact_candidate_toggle';
      await send('Input.dispatchMouseEvent',{type:'mousePressed',x:point.x,y:point.y,button:'left',clickCount:1});await send('Input.dispatchMouseEvent',{type:'mouseReleased',x:point.x,y:point.y,button:'left',clickCount:1});
      stage='observe_enabled_candidate_load';
      const result=await evaluate(`const end=Date.now()+15000;while(Date.now()<end){const p=app.plugins.plugins['obsync-private-sync'];if(p?.state){if(p.state.paired)throw Error('fresh candidate unexpectedly paired');return {loaded:true,paired:false,version:p.manifest.version};}await new Promise(r=>setTimeout(r,100));}throw Error('plugin load deadline');`);
      receipt({result:'PASS',method:'ordinary installed-plugin toggle with trusted CDP pointer',enableReadiness,...result});
    } else if (command === 'pair-observe') {
      stage='observe_independent_claimant_code';
      const codes = await evaluate(`const end=Date.now()+15000;while(Date.now()<end){const shown=(${visibleComparisons.toString()})();if(shown.claimant.length===1&&shown.creator.length===0)return shown;if(shown.claimant.length>1||shown.creator.length)throw Error('comparison role ambiguous');await new Promise(r=>setTimeout(r,100));}throw Error('claimant code deadline');`);
      if (codes.claimant.length !== 1 || codes.creator.length !== 0) throw Error('sole visible claimant comparison required');
      const output = join(run, 'private', 'android-claimant-observation.json');
      writeFileSync(output, JSON.stringify({ code: codes.claimant[0], observedAt: Date.now(), appPid }) + '\n', { mode: 0o600, flag: 'wx' });
      receipt({ result: 'OBSERVED', claimantVisibleCount: 1, independentClaimantObservation: true, privateObservationWritten: true });
    } else if(command==='pair-consent'){
      stage='observe_and_accept_upload_consent';
      if(!/^[a-f0-9]{64}$/.test(input.expectedGenerationHash??''))throw Error('independent expected generation hash required');
      if(input.expectedOldGenerationHash!==undefined&&(!/^[a-f0-9]{64}$/.test(input.expectedOldGenerationHash)||input.expectedOldGenerationHash===input.expectedGenerationHash))throw Error('independent distinct old generation hash required');
      const approvalOutcomeDeadline=Date.now()+20000;
      pairingReadiness={approvalOutcome:{polls:0,deadlineMs:20000}};
      await waitPairConsentOutcome(async budget=>await evaluate(`return await (${rotationPairObservation.toString()})(app,P);`,{current:input.expectedGenerationHash,old:input.expectedOldGenerationHash??null},true,budget),pairingReadiness.approvalOutcome,input.expectedOldGenerationHash!==undefined,undefined,undefined,approvalOutcomeDeadline);
      if(pairingReadiness.approvalOutcome.refused)throw Error('native pairing generation or consent differs');
      if(!pairingReadiness.approvalOutcome.ready)throw Error('creator approval outcome deadline');
      const approvalReadiness=pairingReadiness.approvalOutcome,prior={paired:approvalReadiness.after.paired,consentVisible:approvalReadiness.after.consentVisibleCount===1};
      if(prior.paired){
        stage='verify_independent_known_notes_without_consent_prompt';
        if(prior.consentVisible||!input.knownNotesProof||!input.invitationFile)throw Error('independent prior known-note proof required');
        const proof=privateJson(input.knownNotesProof),invitation=lstatSync(input.invitationFile);
        if(!invitation.isFile()||invitation.isSymbolicLink()||(invitation.mode&0o077)||invitation.uid!==process.getuid())throw Error('private invitation custody required');
        const remainingIndexBudget=Math.max(0,approvalOutcomeDeadline-Date.now());knownNotesIndexReadiness={polls:0,approvalOutcomeBudgetMs:20000,deadlineMs:remainingIndexBudget};
        const indexed=await waitKnownNotesIndex(async budget=>{const snapshot=await evaluate(`const p=app.plugins.plugins['obsync-private-sync'],pin=p.state.custody2();if(pin?.phase!=='active'||pin.suite!==2)throw Error('active same-generation pairing required');const hash=async s=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(s)))).map(v=>v.toString(16).padStart(2,'0')).join('');if(await hash(pin.generation)!==P.generation)throw Error('native pairing generation differs');const rows=[];for(const f of app.vault.getMarkdownFiles()){const r=p.state.fileByPath(f.path);rows.push({path:f.path,fileIdHash:r?.fileId?await hash(r.fileId):null});}return {rows,statusKind:p.currentStatus().kind,waitingHandlePresent:!!p.waiting};`,{generation:input.expectedGenerationHash},true,budget);knownNotesIndexReadiness.after={localNoteCount:snapshot.rows.length,missingIdentityCount:snapshot.rows.filter(r=>r.fileIdHash===null).length,statusKind:snapshot.statusKind,waitingHandlePresent:snapshot.waitingHandlePresent};knownNotesIndexReadiness.polls++;return snapshot;},proof.files,undefined,undefined,remainingIndexBudget);
        knownNotesIndexReadiness={...knownNotesIndexReadiness,...indexed.readiness};if(!knownNotesIndexReadiness.ready)throw Error('known note sync identity readiness deadline');const files=indexed.files;
        const local=[];for(const file of files){if(!/^[A-Za-z0-9 -]+(?:\/[A-Za-z0-9 -]+)*\.md$/.test(file.path))throw Error('synthetic Leave note path refused');local.push({...file,sha256:digest(device('exec-out','cat',androidExecPathArg(ownedVault(input.vaultPath)+'/'+file.path)))});}
        knownNotesMatch(proof,{sourceHead:state.sourceHead,generationHash:input.expectedGenerationHash,invitationTime:invitation.mtimeMs,now:Date.now()},local);
        receipt({result:'PASS',consentNotRequiredKnownNotes:true,unknownLocalNoteCount:0,localNoteCount:local.length,knownNotesIndexReadiness,independentPriorKnownNotesProofSha256:digest(readFileSync(input.knownNotesProof)),approvalReadiness,sourceContract:'PairClaimModal asks only when notesUnknownTo2 > 0',explicitPairAndUpload:false,noConsentClick:true});return;
      }
      const before=await evaluate(`return await (${pairingSnapshot.toString()})(P.expected,(${visibleComparisons.toString()}));`,{expected:input.expectedGenerationHash});
      pairingReadiness={beforeClick:before,approvalOutcome:approvalReadiness};
      stage='wait_stable_exact_upload_consent_pointer';
      pointerReadiness=await evaluate(`const read=()=>{const p=app.plugins.plugins['obsync-private-sync'];if(p.state.paired)throw Error('unpaired consent state required');const ms=[...document.querySelectorAll('.modal:not(.mod-settings)')].filter(m=>m.getClientRects().length&&m.querySelector('.modal-title')?.textContent.trim()==="Add this vault's notes to the server's vault?");if(ms.length!==1)throw Error('sole upload consent required');const bs=[...ms[0].querySelectorAll('button')].filter(b=>b.textContent.trim()==='Pair and upload'&&!b.disabled&&b.getClientRects().length);if(bs.length!==1)throw Error('ordinary upload consent control required');return (${pointerObservation.toString()})(bs[0]);};return await (${waitPointerReadiness.toString()})(read,undefined,undefined,10000,200);`);
      if(!pointerReadiness.ready)throw Error('ordinary consent pointer settling deadline');
      const point={x:pointerReadiness.x,y:pointerReadiness.y};
      stage='trusted_explicit_upload_consent_click';
      await trustedPointerClick({selector:'.modal:not(.mod-settings) button',expectedText:'Pair and upload',modalTitle:"Add this vault's notes to the server's vault?",point});
      stage='observe_active_native_pairing';
      pairingReadiness={beforeClick:before,approvalOutcome:approvalReadiness,polls:0,deadlineMs:45000,startedAtEpochMs:Date.now()};
      const observations=await waitPairingActivation(async budget=>{const observed=await evaluate(`return await (${pairingSnapshot.toString()})(P.expected,(${visibleComparisons.toString()}));`,{expected:input.expectedGenerationHash},true,budget);pairingReadiness.after=observed;pairingReadiness.polls++;pairingReadiness.elapsedMs=Date.now()-pairingReadiness.startedAtEpochMs;return observed;});
      pairingReadiness={...pairingReadiness,...observations};
      if(pairingReadiness.refused)throw Error('native pairing generation differs');
      if(!pairingReadiness.ready)throw Error('active pairing deadline');
      receipt({result:'PASS',ordinaryUploadConsentObserved:true,explicitPairAndUpload:true,actualTrustedConsentClick:true,consentModalDisappeared:pairingReadiness.after.consentVisibleCount===0,pointerReadiness,pointerWitness,pairingReadiness,method:'one witnessed trusted CDP pointer to ordinary Pair and upload',paired:true,suite:2,phase:'active',generationHash:input.expectedGenerationHash});
    } else if (command === 'note-read') {
      stage='wait_persisted_bytes_and_native_note_identity';
      const vault = ownedVault(input.vaultPath);
      syntheticNotePath(input.note);if(typeof input.text !== 'string' || input.text.length > 65536) throw Error('bounded synthetic note required');
      const expected=Buffer.from(input.text),end=Date.now()+15000,expectIdentity=input.expectPaired!==false;let bytes,exists=false,polls=0;
      noteReadiness={deadlineMs:15000};
      const remaining=()=>{const value=end-Date.now();if(value<=0)throw Error('native note readiness deadline');return value;};
      const persisted=()=>{polls++;exists=false;try{deviceBudget(remaining(),'shell','test','-f',androidPathArg(vault+'/'+input.note));exists=true;bytes=deviceBudget(remaining(),'exec-out','cat',androidExecPathArg(vault+'/'+input.note));}catch(error){if(error.status!==1)throw error;}persistedNoteReadback={note:input.note,fileExists:exists,polls,...persistedByteFacts(expected,exists?bytes:undefined)};return persistedNoteReadback.exactBytesMatched;};
      await waitNoteReadiness(async()=>{const exactBytesMatched=persisted();const observed=await evaluate(`return (${noteIndexObservation.toString()})(app,P.note,P.expectIdentity);`,{note:input.note,expectIdentity},true,Math.min(5000,remaining()));return {exactBytesMatched,...observed};},noteReadiness,expectIdentity,undefined,Date.now,end);
      if(noteReadiness.refused)throw Error('native note identity or pairing state invalid');
      if(!noteReadiness.ready)throw Error('native note readiness deadline');
      stage='final_independent_persisted_note_bytes';
      if(!persisted())throw Error('independent Android persisted bytes differ');
      stage='native_editor_and_identity_readback';
      const observed = await evaluate(`const snapshot=()=>(${noteIndexObservation.toString()})(app,P.note,P.expectIdentity);const check=()=>{const f=snapshot();if(!f.stateValid||!f.nativeNotePresent||f.identityPresent&&!f.fileIdValid||P.expectIdentity&&!f.fileIdValid)throw Error('native note identity or pairing state invalid');return f;};check();const f=app.vault.getFileByPath(P.note);await app.workspace.getLeaf(false).openFile(f);const view=app.workspace.getMostRecentLeaf().view;if(view.editor?.getValue()!==P.text)throw Error('native editor bytes differ');const final=check();return {editorMatches:true,fileIdPresent:final.fileIdValid};`, { note: input.note, text: input.text,expectIdentity },true,remaining());
      if(Date.now()>end)throw Error('native note readiness deadline');
      receipt({ result: 'PASS', independentAdbReadback: true, bytes: bytes.length, sha256: digest(bytes),persistedNoteReadback,noteReadiness, ...observed });
    } else if(command==='metadata-export'){
      stage='export_owned_metadata';
      if(!/^[a-z][a-z0-9-]{0,31}$/.test(input.phase??''))throw Error('explicit custody export phase required');
      const vault=ownedVault(input.vaultPath),destination=join(run,'private',`android-custody-${input.phase}`);
      if(existsSync(destination))throw Error('fresh private export destination required');
      const metadata=device('exec-out','cat',vault+'/.obsidian/plugins/obsync-private-sync/data.json');
      if(metadata.length>2*1024*1024||!JSON.parse(metadata.toString())||Array.isArray(JSON.parse(metadata.toString())))throw Error('bounded owned plugin metadata required');
      stage='verify_credential_without_exporting_it';
      const witness=await evaluate(`const p=app.plugins.plugins['obsync-private-sync'];if(!p?.state||p.state.secrets!==app.secretStorage||!/^[a-f0-9]{64}$/.test(p.state.data.deviceSecret??''))throw Error('owned native credential witness unavailable');const secret=p.state.data.deviceSecret,raw=Uint8Array.from(secret.match(/../g),v=>parseInt(v,16));const contains=P.metadata.toLowerCase().includes(secret.toLowerCase())||P.metadata.includes(btoa(String.fromCharCode(...raw)));const credentialHash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify([p.state.data.deviceId,secret]))))).map(v=>v.toString(16).padStart(2,'0')).join('');return {credentialHash,metadataCredentialAbsent:!contains};`,{metadata:metadata.toString()});
      if(!witness.metadataCredentialAbsent)throw Error('owned metadata unexpectedly includes credential; export refused');
      mkdirSync(destination,{mode:0o700});
      writeFileSync(join(destination,'metadata.json'),metadata,{mode:0o600,flag:'wx'});
      receipt({result:witness.metadataCredentialAbsent?'PASS':'FAIL',phase:input.phase,metadataBytes:metadata.length,nativeWitnessWritten:false,nativeSecretStoreUnmodified:true,credentialHash:witness.credentialHash,metadataCredentialAbsent:witness.metadataCredentialAbsent,credentialExport:'NOT_EXPORTED_APPROVAL_REJECTION',rootRead:false,secretInventoryEnumerated:false});
      if(!witness.metadataCredentialAbsent)process.exitCode=1;
    } else if(command==='expect-revoked'){
      stage='read_only_revoked_credential_probe';
      const value=await evaluate(`const p=app.plugins.plugins['obsync-private-sync'];try{await p.transport.account({interactive:true});return {refused:false};}catch(error){return {refused:error?.name==='ApiError'&&error.code==='device_revoked',apiError:error?.name==='ApiError',code:error?.code==='device_revoked'?'device_revoked':'OTHER_REFUSAL'};}`);
      if(!value.refused)throw Error('explicit revoked credential refusal required');
      receipt({result:'PASS',readOnlyAccountRequest:true,apiError:true,code:'device_revoked',accessOnlyAdmissionProof:true,cryptographicRevocationClaimed:false});
    } else if(command==='note-absent'){
      stage='independent_absence_of_revoked_peer_note';
      syntheticNotePath(input.note);
      device('shell','test','!','-e',androidPathArg(ownedVault(input.vaultPath)+'/'+input.note));
      const absent=await evaluate(`return app.vault.getAbstractFileByPath(P.note)===null;`,{note:input.note});
      if(!absent)throw Error('revoked peer unexpectedly received new note');
      receipt({result:'PASS',independentAdbAbsent:true,nativeIndexAbsent:true,receiverSyncRequested:false});
    } else if(command==='leave-open'){
      stage='open_ordinary_leave_dialog';
      await evaluate(`if(!app.plugins.plugins['obsync-private-sync'].state.paired)throw Error('paired fixture required before Leave');app.setting.close();if(app.commands.executeCommandById('obsync-private-sync:leave-server')===false)throw Error('ordinary Leave command unavailable');return true;`);
      receipt({result:'ACTION_COMPLETED',method:'public Obsidian Leave this server command',leaveConfirmed:false});
    } else if(command==='leave-snapshot'||command==='leave-verify'){
      stage='independent_leave_note_preservation';
      const path=join(run,'private','android-access-leave-before.json'),vault=ownedVault(input.vaultPath);
      const files=await evaluate(`const paths=app.vault.getMarkdownFiles().map(f=>f.path).sort();if(!paths.length||paths.length>32)throw Error('bounded synthetic Leave inventory required');return paths;`);
      const hashes={};for(const file of files){if(!/^[A-Za-z0-9 -]+(?:\/[A-Za-z0-9 -]+)*\.md$/.test(file))throw Error('synthetic Leave note path refused');hashes[file]=digest(device('exec-out','cat',androidExecPathArg(vault+'/'+file)));}
      if(command==='leave-snapshot'){writeFileSync(path,JSON.stringify(hashes)+'\n',{mode:0o600,flag:'wx'});receipt({result:'OBSERVED',ownedNoteCount:files.length,independentAdbBeforeHashesWritten:true});}
      else{
        if(JSON.stringify(privateJson(path))!==JSON.stringify(hashes))throw Error('Leave changed local notes');
        const unpaired=await evaluate(`const p=app.plugins.plugins['obsync-private-sync'];return !p.state.paired&&p.state.data.deviceId===null&&p.state.data.deviceSecret===null&&p.state.data.serverUrl==='';`);
        if(!unpaired)throw Error('ordinary Leave did not clear enrollment');
        receipt({result:'PASS',notPaired:true,deviceCredentialCleared:true,serverUrlCleared:true,localNoteCount:files.length,independentAdbNotesUnchanged:true,contentKeyErasureClaimed:false});
      }
    } else if(command==='scope-selected'){
      stage='select_explicit_folder_policy';
      if(!Array.isArray(input.folders)||input.folders.length<1||input.folders.length>4||new Set(input.folders).size!==input.folders.length||input.folders.some(f=>typeof f!=='string'||f.length>128||!f.split('/').every(s=>/^[A-Za-z0-9][A-Za-z0-9 -]*$/.test(s))))throw Error('bounded explicit selected folders required');
      const scopeDom=`const row=name=>{const rs=[...document.querySelectorAll('.setting-item')].filter(r=>r.getClientRects().length&&r.querySelector('.setting-item-name')?.textContent.trim()===name);if(rs.length!==1)throw Error('folder selection setting row ambiguous');return rs[0];};`;
      await evaluate(`app.setting.open();app.setting.openTabById('obsync-private-sync');return true;`);
      await evaluate(scopeDom+`const s=row('Folder selection').querySelector('select');const options=[...s.options].filter(o=>o.textContent.trim()==='Selected folders only');if(options.length!==1)throw Error('selected folder option changed');s.value=options[0].value;s.dispatchEvent(new s.ownerDocument.defaultView.Event('change',{bubbles:true}));const t=row('Selected folders').querySelector('textarea');if(!t||t.disabled)throw Error('selected folder textarea unavailable');t.focus();window.obsyncJourneyScopeInput=null;document.addEventListener('beforeinput',e=>window.obsyncJourneyScopeInput=e.isTrusted,{capture:true,once:true});return true;`);
      await evaluate(`return (${selectAllText.toString()})();`);await send('Input.insertText',{text:input.folders.join('\n')});
      const scopeSaveStarted=Date.now(),scopeSaveDeadline=scopeSaveStarted+30000;
      scopeSaveReadiness={ready:false,polls:0,deadlineMs:30000,startedAtEpochMs:scopeSaveStarted};
      const scopeBudget=()=>{const remaining=scopeSaveDeadline-Date.now();if(remaining<=0)throw Error('saved selected scope deadline');return remaining;};
      scopeSaveReadiness.before=scopeSaveReadiness.after=await evaluate(`return (${scopeSaveObservation.toString()})(app,document,P.folders);`,{folders:input.folders},true,scopeBudget());
      try {
      pointerReadiness=await evaluate(scopeDom+`if(row('Selected folders').querySelector('textarea').value!==P.text||window.obsyncJourneyScopeInput!==true)throw Error('native selected folder input differs');delete window.obsyncJourneyScopeInput;const save=()=>{const bs=[...row('Save on this device').querySelectorAll('button')].filter(b=>b.textContent.trim()==='Save'&&!b.disabled&&b.getClientRects().length);if(bs.length!==1)throw Error('ordinary scope Save control required');return bs[0];};const target=save();target.scrollIntoView({block:'center',inline:'nearest',behavior:'instant'});const read=()=>{if(save()!==target||!target.isConnected)throw Error('ordinary scope Save control changed');return (${pointerObservation.toString()})(target,false);};return await (${waitPointerReadiness.toString()})(read,undefined,undefined,P.budget,200);`,{text:input.folders.join('\n'),budget:Math.min(10000,scopeBudget())},true,scopeBudget());
      if(!pointerReadiness.ready)throw Error('ordinary scope Save pointer readiness deadline');
      const point={x:pointerReadiness.x,y:pointerReadiness.y};
      stage='trusted_selected_scope_save_click';
      await trustedPointerClick({selector:'.modal.mod-settings .setting-item button',expectedText:'Save',settingRow:'Save on this device',point,deadline:scopeSaveDeadline,scroll:false});
      stage='verify_saved_selected_folders';
      const saved=await waitScopeSave(async budget=>{const observed=await evaluate(`return (${scopeSaveObservation.toString()})(app,document,P.folders);`,{folders:input.folders},true,budget);scopeSaveReadiness.after=observed;scopeSaveReadiness.polls++;return observed;},undefined,undefined,30000,scopeSaveDeadline);
      scopeSaveReadiness={...scopeSaveReadiness,...saved,before:scopeSaveReadiness.before,elapsedMs:Date.now()-scopeSaveStarted};
      if(!scopeSaveReadiness.ready)throw Error('saved selected scope deadline');
      } catch(error) {
        if(Date.now()<scopeSaveDeadline)try{scopeSaveReadiness.after=await evaluate(`return (${scopeSaveObservation.toString()})(app,document,P.folders);`,{folders:input.folders},true,Math.min(1000,scopeBudget()));}catch{}
        scopeSaveReadiness.elapsedMs=Date.now()-scopeSaveStarted;throw error;
      }
      receipt({result:'PASS',selectedFolders:input.folders,method:'ordinary select change, trusted textarea input and one row-scoped witnessed Save click',policyChangedThroughSettingsOnly:true,pointerWitness,pointerReadiness,scopeSaveReadiness});
    } else if (command === 'status') {
      stage='read_only_pairing_status';
      if(input.requireIdle===true){stage='observe_automatic_idle_without_pairing_prompt';await evaluate(`const end=Date.now()+20000;while(Date.now()<end){const p=app.plugins.plugins['obsync-private-sync'];if(p?.state?.paired&&p.currentStatus().kind==='idle'&&![...document.querySelectorAll('.modal:not(.mod-settings)')].some(m=>m.getClientRects().length))return true;await new Promise(r=>setTimeout(r,100));}throw Error('automatic native idle deadline');`);}
      const value=await evaluate(`const p=app.plugins.plugins['obsync-private-sync'];if(!p?.state)throw Error('plugin absent');const s=p.currentStatus(),c=p.state.custody2();const hash=async value=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value)))).map(v=>v.toString(16).padStart(2,'0')).join('');return {result:'OBSERVED',paired:p.state.paired,status:s.kind,suite:c?.suite??null,phase:c?.phase??null,generationHash:c?.generation?await hash(c.generation):null,credentialHash:p.state.data.deviceId&&p.state.data.deviceSecret?await hash(JSON.stringify([p.state.data.deviceId,p.state.data.deviceSecret])):null,nativeSecretStoreUnmodified:p.state.secrets===app.secretStorage,version:p.manifest.version};`);
      if(input.requireIdle===true){if(value.status!=='idle')throw Error('automatic native idle changed');value.automaticIdleObserved=true;value.setupOrPairDialogAbsent=true;value.idleObservedAtEpochMs=Date.now();}
      if(input.expectedGenerationHash){if(!value.paired||value.suite!==2||value.phase!=='active'||value.generationHash!==input.expectedGenerationHash)throw Error('native pairing generation differs');value.result='PASS';value.expectedGenerationMatched=true;value.generationHashEncoding='SHA256 UTF8 generation string';value.readOnlyRecheck=true;}
      if(input.expectedCredentialHash){if(value.credentialHash!==input.expectedCredentialHash)throw Error('native credential changed across restart');value.result='PASS';value.expectedCredentialMatched=true;value.credentialHashEncoding='SHA256 UTF8 JSON device ID and secret';value.readOnlyRecheck=true;}
      receipt(value);
    } else throw Error('unknown bounded Android command');
  } catch(error) {
    const generated=new Set([...readFileSync(new URL(import.meta.url),'utf8').matchAll(/\bError\('([^']+)'\)/g)].map(m=>m[1]));
    receipt({ result: 'FAIL',stage,failureClass:'AUTOMATION_OR_ORACLE_REFUSAL',exceptionType:error.name==='Error'?'Error':error.name==='TimeoutError'?'TimeoutError':'ExternalError',timeout:error.code==='ETIMEDOUT'||error.name==='TimeoutError'||generated.has(error.message)&&error.message.endsWith('deadline'),nativeObservations,startupReadiness,enableReadiness,communityTrustReadiness,pointerReadiness,pointerWitness,controlReadiness,serverUrlReadiness,pairingReadiness,scopeSaveReadiness,knownNotesIndexReadiness,persistedNoteReadback,noteReadiness,replacementReadiness,installReadbacks,folderIndexReadiness,external:externalFailure(error),reason:generated.has(error.message)?error.message:'External operation failed; private details withheld.' });
    process.exitCode = 1;
  } finally {
    try {await releaseConnection();}
    catch(error){receipt({result:'FAIL',stage:'release_owned_android_websocket',failureClass:'AUTOMATION_OR_ORACLE_REFUSAL',reason:['owned CDP close deadline','owned CDP close refused','owned CDP release deadline','owned CDP forward removal refused'].includes(error.message)?error.message:'owned CDP release refused'});process.exitCode=1;}
    let stamp=Date.now();for(const result of receipts){
      result.connectReadiness=connectReadiness;
      writeFileSync(join(run,'evidence',`android-journey-${command}-${stamp++}.json`),JSON.stringify(result,null,2)+'\n',{mode:0o600,flag:'wx'});
      console.log(JSON.stringify(result));
    }
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main(process.argv.slice(2));
