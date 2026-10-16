import test from 'node:test';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { parseOwnedRootEntries,readOwnedRootEntries,waitFolderIndex,digest,noteIndexObservation,waitNoteReadiness,waitKnownNotesIndex,waitCandidateReadiness,waitScopeSave,waitPairingActivation,serverUrlCommitMatched,pointerWitnessMatches,androidExecPathArg,persistedByteFacts,freshTrustRoute, comparison, ordinaryControl, ownedVault, visibleComparisons, safeExceptionMessage, knownNotesMatch, selectAllText,nativeScreen,androidPathArg,externalFailure,nativeReadiness,waitNativeReadiness,syntheticNotePath,candidateLabelMatches,restoredSiblingPath,pointerTarget,waitPointerReadiness,waitOwnedPage } from './android-journey.mjs';

test('owned initial debugger waits for zero pages to become one and rejects multiples immediately',async()=>{
  let clock=0,reads=0;const facts={},page={type:'page',webSocketDebuggerUrl:'owned'};
  assert.equal(await waitOwnedPage(async()=>++reads===1?[]:[page],facts,async ms=>{clock+=ms;},()=>clock,300),page);
  assert.equal(facts.beforePageCount,0);assert.equal(facts.afterPageCount,1);assert.equal(facts.pageWaitMs,100);
  let pauses=0;await assert.rejects(waitOwnedPage(async()=>[page,page],{},async()=>{pauses++;},()=>0,300),/multiple owned/);assert.equal(pauses,0);
  clock=0;await assert.rejects(waitOwnedPage(async()=>[],{},async ms=>{clock+=ms;},()=>clock,300),/readiness deadline/);assert.equal(clock,300);
});

test('pointer readiness observes an occluding transition but never clicks or ignores a persistent blocker',async()=>{
  let clock=0,reads=0;const blocked={ready:false,x:5,y:5,diagnostic:{pointerViewportMatched:true,pointerHitTargetMatched:false,blocker:{tag:'DIV',classes:'transition'}}};
  const clear={...blocked,ready:true,pointerViewportMatched:true,pointerHitTargetMatched:true,diagnostic:{pointerViewportMatched:true,pointerHitTargetMatched:true,blocker:null}};
  const ready=await waitPointerReadiness(()=>++reads===1?blocked:clear,async ms=>{clock+=ms;},()=>clock,300);assert.equal(ready.ready,true);assert.equal(ready.before.blocker.classes,'transition');assert.equal(ready.after.blocker,null);assert.equal(ready.polls,2);
  clock=0;const no=await waitPointerReadiness(()=>blocked,async ms=>{clock+=ms;},()=>clock,300);assert.equal(no.ready,false);assert.equal(clock,300);assert.equal(no.after.pointerHitTargetMatched,false);
});

test('trusted pointer requires a visible viewport center hitting the exact control',()=>{
  const doc={defaultView:{innerWidth:300,innerHeight:500},elementFromPoint:()=>element};
  const element={ownerDocument:doc,scrollIntoView(){},getBoundingClientRect:()=>({x:10,y:10,width:100,height:30}),contains:()=>false};
  assert.equal(pointerTarget(element).pointerHitTargetMatched,true);
  doc.elementFromPoint=()=>({});assert.throws(()=>pointerTarget(element),/occluded/);
  doc.elementFromPoint=()=>element;doc.defaultView.visualViewport={offsetLeft:0,offsetTop:0,width:300,height:20};assert.throws(()=>pointerTarget(element),/viewport/);
});

test('history restore accepts only the one source-bound generated sibling pattern',()=>{
  const path='Retained (restored-'+('a'.repeat(32))+').md';assert.equal(restoredSiblingPath('Retained.md',path),true);assert.equal(syntheticNotePath(path),path);
  for(const p of [path.replace('Retained','Other'),path+'x',path.replace('a','g'),path.replace('restored-','copy-')])assert.equal(restoredSiblingPath('Retained.md',p),false);
});

test('candidate label binds observed name and exact version across ordinary whitespace',()=>{
  const name='Self Hosted Private Sync';
  assert.equal(candidateLabelMatches(name,'1.1.8',name+'\nv1.1.8 By Samuel'),true);
  for(const label of [name+' v1.1.80',name+' v1.1.8.1','Other plugin v1.1.8',name+' v1x1x8'])assert.equal(candidateLabelMatches(name,'1.1.8',label),false);
});

test('selected note reads allow bounded synthetic descendants but reject traversal and metadata',()=>{
  assert.equal(syntheticNotePath('Team docs/One.md'),'Team docs/One.md');assert.equal(syntheticNotePath('One.md'),'One.md');
  for(const path of ['../One.md','.obsidian/data.md','Team docs/../One.md','a/b/c/d/One.md','a//One.md','a/One.md;id'])assert.throws(()=>syntheticNotePath(path));
});

test('startup waits for exact vault, native layout and real plugin registries before install',async()=>{
  const vault='/storage/emulated/0/Documents/Obsync-Test',ready={vault:{adapter:{basePath:vault}},workspace:{layoutReady:true},plugins:{plugins:{},manifests:{}},setting:{open(){},openTabById(){}}};
  const initial=nativeReadiness({vault:ready.vault},vault);assert.equal(initial.ready,false);
  let clock=0,reads=0;const proof=await waitNativeReadiness(()=>++reads===1?initial:nativeReadiness(ready,vault),async ms=>{clock+=ms;},()=>clock,1000);
  assert.equal(proof.before.ready,false);assert.equal(proof.after.ready,true);assert.equal(proof.polls,2);
  for(const app of [{...ready,plugins:{}},{...ready,workspace:{layoutReady:false}},{...ready,setting:{}}]){clock=0;const no=await waitNativeReadiness(()=>nativeReadiness(app,vault),async ms=>{clock+=ms;},()=>clock,200);assert.equal(no.ready,false);assert.equal(clock,200);}
  await assert.rejects(waitNativeReadiness(()=>nativeReadiness(ready,'/foreign')),/foreign vault/);
});

test('external diagnostics classify expected failures without publishing stderr values',()=>{
  assert.deepEqual(externalFailure({code:'ENOENT',status:128,signal:null,stderr:Buffer.from('fatal: not a git repository /private/value')}),{code:'ENOENT',status:128,signal:null,stderrClass:'git_not_repository'});
  const output=JSON.stringify(externalFailure({code:'secret string',stderr:Buffer.from('unexpected private value')}));
  assert.equal(output.includes('private value'),false);assert.equal(output.includes('secret string'),false);
});

test('synthetic Android folder paths preserve spaces through ADB shell joining',()=>{
  assert.equal(androidPathArg('/storage/emulated/0/Documents/Obsync-Test/Team docs/One.md'),"'/storage/emulated/0/Documents/Obsync-Test/Team docs/One.md'");
  for(const p of ['a;echo private',"a'",'a\ncat','$(cat x)','`cat x`'])assert.throws(()=>androidPathArg(p));
});

test('native transition snapshots never activate app content or the wrong permission screen',()=>{
  const input={nativeResourceId:'',nativeText:'',nativeRequiredText:'Allow access to manage all files',nativeCheckable:true,nativeChecked:false};
  const node=(pkg,attrs)=>'<node package="'+pkg+'" enabled="true" '+attrs+'/>';
  const target=node('com.android.settings','text="" resource-id="" clickable="true" checkable="true" checked="false" bounds="[1,2][3,4]"');
  const label=node('com.android.settings','text="Allow access to manage all files"');
  assert.equal(nativeScreen('UI hierarchy dumped to: /dev/tty',input).ready,false);
  assert.equal(nativeScreen(node('md.obsidian','text="Allow access to manage all files"'),input).ready,false);
  assert.equal(nativeScreen(target,input).ready,false);
  assert.equal(nativeScreen(label+target,input).ready,true);
  assert.equal(nativeScreen(label+target+target,input).ready,false);
  assert.equal(nativeScreen(label+target.replace('checked="false"','checked="true"'),input).ready,false);
});

test('title replacement selects the complete actual contenteditable text',()=>{
  let selected='';
  const selection={removeAllRanges(){selected='';},addRange(range){selected=range.text;},toString(){return selected;}};
  const element={isContentEditable:true,textContent:'Untitled',ownerDocument:{createRange(){return {selectNodeContents(e){this.text=e.textContent;}};},getSelection(){return selection;}}};
  globalThis.document={activeElement:element};assert.equal(selectAllText(),true);assert.equal(selected,'Untitled');
  element.ownerDocument.createRange=()=>({selectNodeContents(){this.text='title suffix';}});
  assert.throws(()=>selectAllText());delete globalThis.document;
});

test('no-prompt pairing needs independent prior same-generation identities and all local bytes',()=>{
  const row={path:'Known.md',sha256:'a'.repeat(64),fileIdHash:'b'.repeat(64)};
  const context={sourceHead:'c'.repeat(40),generationHash:'d'.repeat(64),invitationTime:2000,now:3000};
  const proof={schema:1,sourceHead:context.sourceHead,generationHash:context.generationHash,observedAt:1000,completeServerInventory:true,files:[row]};
  assert.equal(knownNotesMatch(proof,context,[row]),true);
  for(const bad of [{...proof,sourceHead:'e'.repeat(40)},{...proof,observedAt:2500},{...proof,files:[]},{...proof,generationHash:'e'.repeat(64)},{...proof,completeServerInventory:false}])assert.throws(()=>knownNotesMatch(bad,context,[row]));
  assert.throws(()=>knownNotesMatch(proof,context,[{...row,sha256:'f'.repeat(64)}]));
  assert.throws(()=>knownNotesMatch(proof,context,[{...row,fileIdHash:'f'.repeat(64)}]));
  assert.throws(()=>knownNotesMatch(proof,context,[row,{...row,path:'Unknown.md'}]));
});

test('only constant driver-authored exceptions enter reduced receipts',()=>{
  const allowed=new Set(['native pairing generation differs']);
  assert.equal(safeExceptionMessage('Error: native pairing generation differs\n at eval',allowed),'native pairing generation differs');
  assert.equal(safeExceptionMessage('Error: private invitation contents',allowed),'owned UI refused or timed out');
});

test('independently observed codes require one matching code per role', () => {
  assert.equal(comparison(['123 456'], ['123 456']), true);
  for (const [a, b] of [[[], ['123 456']], [['123 456'], []], [['123 456'], ['654 321']], [['123 456', '123 456'], ['123 456']], [['123456'], ['123456']]]) assert.throws(() => comparison(a, b));
});
test('ordinary control refuses hidden, duplicate and disabled controls before action', () => {
  let clicks = 0;
  const element = (width = 10, disabled = false) => ({ disabled, getBoundingClientRect: () => ({ width, height: 10 }), scrollIntoView() {}, click() { clicks++; }, focus() {} });
  for (const nodes of [[], [element(0)], [element(), element()], [element(10, true)]]) {
    globalThis.document = { querySelectorAll: () => nodes };
    assert.throws(() => ordinaryControl('button', 'click'));
  }
  assert.equal(clicks, 0);
  globalThis.document = { querySelectorAll: () => [element()] };
  ordinaryControl('button', 'click'); assert.equal(clicks, 1);
  globalThis.document = { querySelectorAll: () => [{ ...element(), textContent: 'Wrong action' }] };
  assert.throws(() => ordinaryControl('button', 'click', 'Expected action'));
  assert.equal(clicks, 1);
  delete globalThis.document;
});
test('comparison observations exclude hidden modals and distinguish roles', () => {
  const modal = (textContent, width = 10) => ({ textContent, getBoundingClientRect: () => ({ width, height: 10 }) });
  globalThis.document = { querySelectorAll: () => [modal('Approve only if the new device shows the code 123 456.'), modal('Waiting for approval on the other device. Its prompt shows the code 654 321:'), modal('Approve only if the new device shows the code 999 999.', 0)] };
  assert.deepEqual(visibleComparisons(), { creator: ['123 456'], claimant: ['654 321'] });
  delete globalThis.document;
});
test('device path cannot escape the explicitly synthetic document vault', () => {
  assert.equal(ownedVault('/storage/emulated/0/Documents/Obsync-Fresh-1'), '/storage/emulated/0/Documents/Obsync-Fresh-1');
  for (const path of ['/storage/emulated/0/Documents/Personal', '/storage/emulated/0/Documents/Obsync-A/../B', '/storage/emulated/0/Documents/Obsync-A/.obsidian']) assert.throws(() => ownedVault(path));
});

test('native trust chooses only the exact fresh source-defined prompt or settled restricted settings',()=>{
  const pending={candidateManifest:true,candidateLoaded:false,communityPluginsEnabled:false,trustModalCount:0,otherModalCount:0,layoutReady:false};
  assert.equal(freshTrustRoute(pending),null);assert.equal(freshTrustRoute({...pending,layoutReady:true}),'RESTRICTED_SETTINGS');
  const prompt={...pending,trustModalCount:1,trustTitleMatched:true,trustButtons:1,restrictedButtons:1};
  assert.equal(freshTrustRoute(prompt),'INITIAL_TRUST_MODAL');
  for(const delta of [{candidateLoaded:true},{communityPluginsEnabled:true},{trustModalCount:2},{otherModalCount:1},{trustTitleMatched:false},{trustButtons:2},{restrictedButtons:0}])assert.throws(()=>freshTrustRoute({...prompt,...delta}));
  assert.equal(freshTrustRoute({...pending,candidateManifest:false,layoutReady:true}),null);
});

test('exec-out path arguments remain raw while shell arguments receive exactly one quote layer',()=>{
  const path='/storage/emulated/0/Documents/Obsync-Test/Team docs/One.md';
  assert.equal(androidExecPathArg(path),path);assert.equal(androidPathArg(path),"'"+path+"'");
  assert.throws(()=>androidExecPathArg(path+';id'));
  const quotedByAdb=s=>"'"+s.replaceAll("'","'\\''")+"'";
  assert.equal(quotedByAdb(androidExecPathArg(path)),androidPathArg(path));
  assert.notEqual(quotedByAdb(androidPathArg(path)),androidPathArg(path));
  const asShellArg=arg=>execFileSync('/bin/sh',['-c',"printf '%s' "+quotedByAdb(arg)],{encoding:'utf8'});
  assert.equal(asShellArg(androidExecPathArg(path)),path);
  assert.equal(asShellArg(androidPathArg(path)),androidPathArg(path));
});
test('persisted mismatch evidence never normalizes bytes or accepts missing, empty, truncated and cat diagnostics',()=>{
  const expected=Buffer.from('synthetic note\n');
  assert.equal(persistedByteFacts(expected,expected).exactBytesMatched,true);
  for(const actual of [undefined,Buffer.alloc(0),expected.subarray(0,-1),Buffer.from('synthetic note\r\n'),Buffer.from('cat: missing file\n')]){
    const result=persistedByteFacts(expected,actual);assert.equal(result.exactBytesMatched,false);assert.equal(result.expectedBytes,expected.length);assert.equal(result.observedBytes,actual?.length??null);
  }
});

test('ordinary click witness refuses swallowed, untrusted, shifted, duplicate or missing browser events',()=>{
  const event={count:1,trusted:true,expectedTargetMatched:true},good={mousedown:{...event},mouseup:{...event},click:{...event}};
  assert.equal(pointerWitnessMatches(good),true);
  for(const kind of ['mousedown','mouseup','click'])for(const delta of [{count:0},{count:2},{trusted:false},{expectedTargetMatched:false}])assert.equal(pointerWitnessMatches({...good,[kind]:{...event,...delta}}),false);
  assert.equal(pointerWitnessMatches({}),false);
});

test('ordinary endpoint commit requires both native adoption and independent saved metadata while unpaired',()=>{
  const good={nativeUrlMatches:true,savedMetadataUrlMatches:true,paired:false,nativeDeviceIdAbsent:true};assert.equal(serverUrlCommitMatched(good),true);
  for(const [key,value]of Object.entries(good))assert.equal(serverUrlCommitMatched({...good,[key]:!value}),false);
  assert.equal(serverUrlCommitMatched({}),false);
});

test('pair activation uses short observations within the existing outer deadline and requires modal disappearance',async()=>{
  let clock=0,reads=0;const budgets=[],pending={paired:false,suite:2,phase:'enrollment',generationMatched:null,consentVisibleCount:1},active={paired:true,suite:2,phase:'active',generationMatched:true,consentVisibleCount:0};
  const pass=await waitPairingActivation(async budget=>{budgets.push(budget);return ++reads===1?{...active,consentVisibleCount:1}:active;},async ms=>{clock+=ms;},()=>clock,300);
  assert.equal(pass.ready,true);assert.equal(pass.polls,2);assert.deepEqual(budgets,[300,200]);
  clock=0;const fail=await waitPairingActivation(async()=>pending,async ms=>{clock+=ms;},()=>clock,300);assert.equal(fail.ready,false);assert.equal(fail.elapsedMs,300);assert.equal(fail.after.phase,'enrollment');
  clock=0;const wrong=await waitPairingActivation(async()=>({...active,generationMatched:false}),async ms=>{clock+=ms;},()=>clock,300);assert.equal(wrong.refused,true);assert.equal(wrong.ready,false);
  clock=0;const late=await waitPairingActivation(async()=>{clock=301;return active;},async()=>{},()=>clock,300);assert.equal(late.ready,false);
});

test('consent pointer must settle after motion inside the existing budget and cannot pass continued movement',async()=>{
  let clock=0,reads=0;const point=(x,ready=true)=>({ready,x,y:5,pointerViewportMatched:true,pointerHitTargetMatched:ready,diagnostic:{pointerViewportMatched:true,pointerHitTargetMatched:ready}});
  const settled=await waitPointerReadiness(()=>point(++reads===1?10:20),async ms=>{clock+=ms;},()=>clock,600,200);
  assert.equal(settled.ready,true);assert.equal(clock,300);assert.equal(settled.coordinateChanges,1);assert.deepEqual(settled.beforePoint,{x:10,y:5});assert.deepEqual(settled.afterPoint,{x:20,y:5});assert.equal(settled.observedStableMs,200);
  clock=0;reads=0;const moving=await waitPointerReadiness(()=>point(++reads*10),async ms=>{clock+=ms;},()=>clock,300,200);assert.equal(moving.ready,false);assert.equal(clock,300);assert.equal(moving.coordinateChanges,3);
  clock=0;reads=0;const interrupted=await waitPointerReadiness(()=>++reads===2?point(10,false):point(10),async ms=>{clock+=ms;},()=>clock,600,200);assert.equal(interrupted.ready,true);assert.equal(clock,400);
});

test('candidate readiness20s and pointer10s remain separate bounded observations with revalidation',async()=>{
  let clock=0;const candidate=await waitCandidateReadiness(()=>({facts:{candidatePresent:clock>=19900},ready:clock>=19900,refused:false}),async ms=>{clock+=ms;},()=>clock);
  assert.equal(candidate.ready,true);assert.equal(candidate.deadlineMs,20000);assert.equal(candidate.elapsedMs,19900);
  const pointerStart=clock;const point=()=>({ready:clock-pointerStart>=9900,x:5,y:5,diagnostic:{}});const pointer=await waitPointerReadiness(point,async ms=>{clock+=ms;},()=>clock);
  assert.equal(pointer.ready,true);assert.equal(clock-pointerStart,9900);assert.equal(clock,29800);
  clock=0;const ambiguous=await waitCandidateReadiness(()=>({facts:{ambiguous:true},ready:false,refused:true}),async()=>{throw Error('must not wait');},()=>clock);assert.equal(ambiguous.ready,false);assert.equal(ambiguous.polls,1);
});
test('saved scope retains30s outer budget with short reads and both independent state booleans',async()=>{
  let clock=0;const budgets=[];const pass=await waitScopeSave(async budget=>{budgets.push(budget);return {changingScope:clock<100,policyMatches:true};},async ms=>{clock+=ms;},()=>clock);assert.equal(pass.ready,true);assert.equal(pass.deadlineMs,30000);assert.deepEqual(budgets,[5000,5000]);
  for(const state of [{changingScope:true,policyMatches:true},{changingScope:false,policyMatches:false}]){clock=0;const fail=await waitScopeSave(async budget=>{assert.ok(budget<=5000);return state;},async ms=>{clock+=ms;},()=>clock);assert.equal(fail.ready,false);assert.equal(fail.elapsedMs,30000);}
  clock=0;const late=await waitScopeSave(async()=>{clock=30001;return {changingScope:false,policyMatches:true};},async()=>{},()=>clock);assert.equal(late.ready,false);
});

test('known-note identity admission waits only for missing native IDs and cannot retry away mismatches',async()=>{
  const row={path:'Known.md',fileIdHash:'b'.repeat(64)},snapshot=rows=>({rows,statusKind:'idle',waitingHandlePresent:false});let clock=0,reads=0;
  const pass=await waitKnownNotesIndex(async budget=>{assert.ok(budget<=5000);return snapshot([{...row,fileIdHash:++reads===1?null:row.fileIdHash}]);},[row],async ms=>{clock+=ms;},()=>clock,300);
  assert.equal(pass.readiness.ready,true);assert.equal(pass.readiness.before.missingIdentityCount,1);assert.equal(pass.readiness.after.missingIdentityCount,0);assert.deepEqual(pass.files,[row]);
  clock=0;const absent=await waitKnownNotesIndex(async()=>snapshot([{...row,fileIdHash:null}]),[row],async ms=>{clock+=ms;},()=>clock,300);assert.equal(absent.readiness.ready,false);assert.equal(clock,300);
  for(const bad of [{...row,fileIdHash:'f'.repeat(64)},{...row,path:'Unknown.md',fileIdHash:null}]){let pauses=0;await assert.rejects(waitKnownNotesIndex(async()=>snapshot([bad]),[row],async()=>{pauses++;},()=>0,300),/not independently known/);assert.equal(pauses,0);}
  clock=0;reads=0;await assert.rejects(waitKnownNotesIndex(async()=>snapshot(++reads===1?[{...row,fileIdHash:null}]:[]),[row],async ms=>{clock+=ms;},()=>clock,300),/inventory changed/);
  clock=0;const late=await waitKnownNotesIndex(async()=>{clock=301;return snapshot([row]);},[row],async()=>{},()=>clock,300);assert.equal(late.readiness.ready,false);
});

test('known-note readiness allows only prior-authenticated arrivals while preserving every original local path',async()=>{
  const original={path:'Known.md',fileIdHash:'b'.repeat(64)},arrival={path:'Blocked-desktop.md',fileIdHash:'c'.repeat(64)},snapshot=rows=>({rows,statusKind:'idle',waitingHandlePresent:false});let clock=0,reads=0;
  const allowed=await waitKnownNotesIndex(async()=>snapshot(++reads===1?[{...original,fileIdHash:null}]:[original,arrival]),[original,arrival],async ms=>{clock+=ms;},()=>clock,300);assert.equal(allowed.readiness.ready,true);assert.equal(allowed.readiness.before.localNoteCount,1);assert.equal(allowed.readiness.after.localNoteCount,2);
  clock=0;reads=0;await assert.rejects(waitKnownNotesIndex(async()=>snapshot(++reads===1?[{...original,fileIdHash:null}]:[arrival]),[original,arrival],async ms=>{clock+=ms;},()=>clock,300),/inventory changed/);
  clock=0;reads=0;await assert.rejects(waitKnownNotesIndex(async()=>snapshot(++reads===1?[{...original,fileIdHash:null}]:[original,{...arrival,path:'Unknown.md'}]),[original,arrival],async ms=>{clock+=ms;},()=>clock,300),/not independently known/);
});

test('production history filter needs Restart search to render Search and Restart never runs the query',async()=>{
  const source=(await import('node:fs')).readFileSync(new URL('../../plugin/src/ui/history.ts',import.meta.url),'utf8');
  const body=name=>{const found=new RegExp('private '+name+'\\(\\): void \\{\\n([\\s\\S]*?)\\n  \\}').exec(source);assert.ok(found,'source history method '+name);return found[1];};
  let buttons=[],filterChanged,opened=0,closed=0,queries=0;
  class Setting{
    setName(name){this.name=name;return this;}setDesc(){return this;}
    addToggle(callback){callback({setValue(){return this;},setDisabled(){return this;},onChange(){return this;}});return this;}
    addText(callback){const component={setValue(){return this;},setDisabled(){return this;},onChange:fn=>{if(this.name==='Filename contains')filterChanged=fn;return component;}};callback(component);return this;}
    addButton(callback){const button={label:null,click:null,setButtonText(text){this.label=text;return this;},setDisabled(){return this;},onClick(fn){this.click=fn;return this;}};callback(button);buttons.push(button);return this;}
  }
  const view={closed:false,busy:false,previous:true,newestFirst:true,filter:'',rows:[],progress:'',message:'',browser:{done:false},
    contentEl:{empty(){buttons=[];},createEl(){}},plugin:{state:{custody2:()=>({history:{suite:2}})},closeHistory(){closed++;},openHistory(){opened++;return {done:false};}},load(){queries++;}};
  view.render=new Function('Setting','formatBytes','HISTORY_SCAN_RECORDS','HISTORY_SEARCH_MS',body('render')).bind(view,Setting,n=>n+' B',20,30000);
  view.restart=new Function(body('restart')).bind(view);view.render();
  assert.ok(buttons.some(b=>b.label==='Load next'));assert.equal(buttons.some(b=>b.label==='Search'),false);
  filterChanged('Known.md');assert.equal(view.filter,'Known.md');assert.ok(buttons.some(b=>b.label==='Load next'));
  buttons.find(b=>b.label==='Restart search').click();assert.equal(opened,1);assert.equal(closed,1);assert.equal(queries,0);assert.ok(buttons.some(b=>b.label==='Search'));
  buttons.find(b=>b.label==='Search').click();assert.equal(queries,1);
  // Execute the real compound driver's filtering/control actions against the
  // production render fixture; deleting its Restart step must break this test.
  const driver=(await import('node:fs')).readFileSync(new URL('./android-journey.mjs',import.meta.url),'utf8');
  const first=driver.indexOf("        await step('filter_retained_filename'"),last=driver.indexOf("        await step('restore_unique_retained_content'",first);assert.ok(first>=0&&last>first);
  const sequence=new Function('step','base','input','return (async()=>{'+driver.slice(first,last)+'})()');
  const run=async omitRestart=>{
    view.filter='';view.restart();opened=closed=queries=0;
    await sequence(async(_name,command,data)=>{
      if(command==='type'){filterChanged(data.text);return;}
      assert.equal(command,'control');if(omitRestart&&data.expectedText==='Restart search')return;
      const matches=buttons.filter(button=>button.label===data.expectedText);assert.equal(matches.length,1,'ordinary history control '+data.expectedText+' must exist');matches[0].click();
    },{},{note:'Known.md'});
  };
  await run(false);assert.equal(opened,1);assert.equal(closed,1);assert.equal(queries,1);
  await assert.rejects(run(true),/ordinary history control Search must exist/);
});


test('note readiness shares one existing deadline for disk and native index/identity without retrying invalid observations',async()=>{
  const good={exactBytesMatched:true,nativeNotePresent:true,identityPresent:true,fileIdValid:true,stateValid:true};let clock=0,reads=0;
  const facts={deadlineMs:300};const budgets=[];
  await waitNoteReadiness(async budget=>{budgets.push(budget);return ++reads===1?{...good,identityPresent:false,fileIdValid:false}:good;},facts,true,async ms=>{clock+=ms;},()=>clock,300);
  assert.equal(facts.ready,true);assert.equal(facts.polls,2);assert.equal(clock,100);assert.deepEqual(budgets,[300,200]);assert.equal(facts.before.identityPresent,false);assert.equal(facts.after.fileIdValid,true);
  for(const missing of [{exactBytesMatched:false},{nativeNotePresent:false},{identityPresent:false,fileIdValid:false}]){
    clock=0;const pending={deadlineMs:300};await waitNoteReadiness(async()=>({...good,...missing}),pending,true,async ms=>{clock+=ms;},()=>clock,300);assert.equal(pending.ready,false);assert.equal(clock,300);
  }
  for(const invalid of [{stateValid:false},{identityPresent:true,fileIdValid:false},{fileIdValid:undefined}]){
    clock=0;const bad={};let pauses=0;await waitNoteReadiness(async()=>({...good,...invalid}),bad,true,async ms=>{pauses++;clock+=ms;},()=>clock,300);assert.equal(bad.refused,true);assert.equal(bad.polls,1);assert.equal(pauses,0);
  }
  clock=0;const optional={};await waitNoteReadiness(async()=>({...good,identityPresent:false,fileIdValid:false}),optional,false,async()=>{},()=>clock,300);assert.equal(optional.ready,true);
  const reduced={};await waitNoteReadiness(async()=>({...good,stateValid:'private-unexpected-value'}),reduced,true,async()=>{},()=>0,300);assert.equal(reduced.refused,true);assert.equal(reduced.after.stateValid,null);assert.equal(JSON.stringify(reduced).includes('private-unexpected-value'),false);
  clock=0;const late={};await waitNoteReadiness(async()=>{clock=301;return good;},late,true,async()=>{},()=>clock,300);assert.equal(late.ready,false);
  clock=0;reads=0;const combined={};await waitNoteReadiness(async()=>++reads===1?{...good,exactBytesMatched:false}:++reads===3?{...good,identityPresent:false,fileIdValid:false}:good,combined,true,async ms=>{clock+=ms;},()=>clock,150);assert.equal(combined.ready,false);assert.equal(clock,150);
});
test('native note observation distinguishes absent IDs from malformed present records and respects only explicit optional identity',async()=>{
  let record;const plugin={state:{paired:true,custody2:()=>({suite:2,phase:'active'}),fileByPath:()=>record},waiting:null};
  const app={plugins:{plugins:{'obsync-private-sync':plugin}},vault:{getFileByPath:()=>({path:'Known.md'})}};
  assert.deepEqual(noteIndexObservation(app,'Known.md',true),{nativeNotePresent:true,identityPresent:false,fileIdValid:false,stateValid:true});
  assert.equal(noteIndexObservation(app,'Known.md',false).stateValid,true,'offline-but-paired active suite2 permits missing publication identity');
  for(const fileId of ['',null,'invalid','A'.repeat(32)]){record={fileId};const seen=noteIndexObservation(app,'Known.md',true);assert.equal(seen.identityPresent,true);assert.equal(seen.fileIdValid,false);}
  record={fileId:'a'.repeat(32)};assert.equal(noteIndexObservation(app,'Known.md',true).fileIdValid,true);
  plugin.state.paired=false;plugin.state.custody2=()=>null;assert.equal(noteIndexObservation(app,'Known.md',true).stateValid,false);assert.equal(noteIndexObservation(app,'Known.md',false).stateValid,true);
  plugin.waiting={};assert.equal(noteIndexObservation(app,'Known.md',false).stateValid,false);
});

test('actual note-read action waits for publication before editor and repeats independent bytes under the original deadline',async()=>{
  const source=(await import('node:fs')).readFileSync(new URL('./android-journey.mjs',import.meta.url),'utf8');
  const first=source.indexOf("      stage='wait_persisted_bytes_and_native_note_identity';"),last=source.indexOf("    } else if(command==='metadata-export')",first);assert.ok(first>0&&last>first);
  const names=['input','ownedVault','syntheticNotePath','Buffer','Date','waitNoteReadiness','deviceBudget','androidPathArg','androidExecPathArg','persistedByteFacts','evaluate','noteIndexObservation','receipt','digest'];
  const action=new Function(...names,'return (async()=>{let stage,noteReadiness,persistedNoteReadback;'+source.slice(first,last)+'})()');
  const run=async({forever=false,badIdentity=false,badState=false,wrongFinalBytes=false,wrongEditor=false,lateEditor=false,initialBytesDelay=0}={})=>{
    let clock=0,identityReads=0,adbReads=0,editorReads=0,receipts=[];const deadlines=[];
    const deviceBudget=(budget,...argv)=>{assert.ok(budget>0&&budget<=15000-clock);if(argv[0]==='exec-out'){adbReads++;if(adbReads===1)clock+=initialBytesDelay;return Buffer.from(wrongFinalBytes&&adbReads>=3?'wrong bytes':'known bytes');}return Buffer.from('');};
    const evaluate=async(body,params,_vault,budget)=>{assert.ok(budget>0&&budget<=15000-clock);deadlines.push(budget);if(body.includes('openFile')){editorReads++;if(lateEditor)clock+=15001;if(wrongEditor)throw Error('native editor bytes differ');return {editorMatches:true,fileIdPresent:true};}identityReads++;return {nativeNotePresent:true,identityPresent:badIdentity||!forever&&identityReads>=2,fileIdValid:!badIdentity&&!forever&&identityReads>=2,stateValid:!badState};};
    const wait=(read,facts,expected,_pause,now,end)=>waitNoteReadiness(read,facts,expected,async ms=>{clock+=ms;},now,end);
    try{await action({note:'Known.md',text:'known bytes'},()=>'/owned',syntheticNotePath,Buffer,{now:()=>clock},wait,deviceBudget,androidPathArg,androidExecPathArg,persistedByteFacts,evaluate,noteIndexObservation,value=>receipts.push(value),digest);}catch(error){error.observedClock=clock;error.editorReads=editorReads;throw error;}
    return {clock,identityReads,adbReads,editorReads,receipts,deadlines};
  };
  const pass=await run();assert.equal(pass.identityReads,2);assert.equal(pass.adbReads,3);assert.equal(pass.editorReads,1);assert.equal(pass.clock,100);assert.equal(pass.receipts[0].result,'PASS');assert.equal(pass.receipts[0].noteReadiness.deadlineMs,15000);
  for(const [options,reason]of [[{forever:true},/native note readiness deadline/],[{badIdentity:true},/native note identity or pairing state invalid/],[{badState:true},/native note identity or pairing state invalid/],[{wrongFinalBytes:true},/independent Android persisted bytes differ/],[{wrongEditor:true},/native editor bytes differ/],[{lateEditor:true},/native note readiness deadline/],[{initialBytesDelay:14950},/native note readiness deadline/]])await assert.rejects(run(options),error=>{assert.match(error.message,reason);if(options.forever||options.initialBytesDelay)assert.equal(error.observedClock,15000);if(options.forever||options.badIdentity||options.badState||options.initialBytesDelay)assert.equal(error.editorReads,0);return true;});
});


test('actual final native editor readback requires exact bytes and rechecks identity after the ordinary open',async()=>{
  const source=(await import('node:fs')).readFileSync(new URL('./android-journey.mjs',import.meta.url),'utf8');
  const start=source.indexOf("      stage='native_editor_and_identity_readback';",source.indexOf("command === 'note-read'"));
  const body=/const observed = await evaluate\(`([\s\S]*?)`, \{ note: input.note/.exec(source.slice(start))?.[1];assert.ok(body);
  const render=new Function('app','P','return (async()=>{'+body.replaceAll('${noteIndexObservation.toString()}',noteIndexObservation.toString())+'})()');
  let fileId='a'.repeat(32),editorText='known bytes',opens=0,corruptAfterOpen=false;
  const plugin={state:{paired:true,custody2:()=>({suite:2,phase:'active'}),fileByPath:()=>({fileId})},waiting:null};
  const view={editor:{getValue:()=>editorText}},app={plugins:{plugins:{'obsync-private-sync':plugin}},vault:{getFileByPath:()=>({path:'Known.md'})},workspace:{getLeaf:()=>({async openFile(){opens++;if(corruptAfterOpen)fileId='invalid';}}),getMostRecentLeaf:()=>({view})}};
  const P={note:'Known.md',text:'known bytes',expectIdentity:true};assert.deepEqual(await render(app,P),{editorMatches:true,fileIdPresent:true});assert.equal(opens,1);
  editorText='wrong bytes';await assert.rejects(render(app,P),/native editor bytes differ/);
  editorText='known bytes';corruptAfterOpen=true;await assert.rejects(render(app,P),/native note identity or pairing state invalid/);
});

test('actual fixed-asset install retains single-read bytes and lifecycle facts, and a matching remote hash never rescues a mismatch',async()=>{
  const source=(await import('node:fs')).readFileSync(new URL('./android-journey.mjs',import.meta.url),'utf8');
  const start=source.indexOf("      stage='install_owned_vault_path';"),end=source.indexOf("    } else if (command === 'settings')",start);assert.ok(start>=0&&end>start);
  const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
  const action=new AsyncFunction('input','state','ownedVault','realpathSync','privateJson','execFileSync','readyNativeStartup','evaluate','device','join','lstatSync','readFileSync','digest','persistedByteFacts','installProcessFacts','deviceBudget','externalFailure','receipt','connectReadiness','Date','let stage,installReadbacks,startupReadiness;try{'+source.slice(start,end)+';return installReadbacks;}catch(error){error.installReadbacks=installReadbacks;throw error;}');
  async function run(mode='exact'){
    const files=Object.fromEntries(['main.js','manifest.json','styles.css'].map(name=>[name,Buffer.from('PUBLIC SYNTHETIC '+name+'\n')]));
    const hashes=Object.fromEntries(Object.entries(files).map(([name,bytes])=>[name,digest(bytes)]));let clock=0,rawReads=0,shellReads=0,sourceReads=0;if(mode==='bad-format')hashes['main.js']='invalid';const pushed=[],receipts=[];
    const device=(...argv)=>{if(argv[0]==='push')pushed.push(argv[1].split('/').at(-1));if(argv[0]!=='exec-out')return Buffer.alloc(0);rawReads++;const bytes=files[argv[2].split('/').at(-1)];if(mode==='read-throws')throw Object.assign(Error('private transport detail'),{code:'ETIMEDOUT'});return mode==='truncated'||mode.startsWith('diagnostics-')?bytes.subarray(0,-1):mode==='padded'?Buffer.concat([bytes,Buffer.from('cat: private error\n')]):mode==='changed'?Buffer.alloc(bytes.length):bytes;};
    const deviceBudget=(budget,...argv)=>{assert.ok(budget>0&&budget<=4000-clock);shellReads++;if(mode==='diagnostics-fail')throw Object.assign(Error('private transport detail'),{stderr:Buffer.from('private stderr')});if(mode==='diagnostics-expire')clock=4000;if(argv.includes('stat'))return Buffer.from(mode==='diagnostics-invalid'?'not-number':String(files['main.js'].length));if(argv.includes('sha256sum'))return Buffer.from(hashes['main.js']+'  '+argv.at(-1)+'\n');if(argv[0]==='get-state')return Buffer.from('device');return Buffer.from('111');};
    const input={vaultPath:'/storage/emulated/0/Documents/Obsync-Install',sourceDir:'/owned/source',preflight:'/owned/preflight'},state={sourceHead:'a'.repeat(40)};
    try{const readbacks=await action(input,state,ownedVault,x=>x,()=>({sourceHead:state.sourceHead,sourceClean:true,pluginHashes:hashes}),(_cmd,argv)=>argv.includes('rev-parse')?state.sourceHead:'',async()=>{},async()=>true,device,(...parts)=>parts.join('/'),()=>({isFile:()=>mode!=='not-file',isSymbolicLink:()=>mode==='symlink'}),path=>{sourceReads++;return mode==='source-changed'&&sourceReads===2?Buffer.from('changed pinned source'):files[path.split('/').at(-1)];},digest,persistedByteFacts,()=>({holder:'MATCH',adb:'MATCH',emulator:'MATCH'}),deviceBudget,externalFailure,r=>receipts.push(r),{appPid:111},{now:()=>clock});return {readbacks,pushed,rawReads,shellReads,receipts};}
    catch(error){error.rawReads=rawReads;error.shellReads=shellReads;error.sourceReads=sourceReads;error.pushed=pushed;throw error;}
  }
  const pass=await run();assert.equal(pass.rawReads,3);assert.equal(pass.shellReads,0);assert.equal(pass.receipts[0].result,'PASS');
  for(const read of pass.readbacks){assert.equal(read.readAttempts,1);assert.equal(read.exactBytesMatched,true);assert.equal(read.expectedBytes,read.observedBytes);assert.equal(read.expectedSha256,read.observedSha256);assert.equal(read.sourceStillPinned,true);assert.equal(read.after.adb,'MATCH');}
  for(const mode of ['truncated','padded','changed','diagnostics-fail','diagnostics-expire','diagnostics-invalid'])await assert.rejects(run(mode),error=>{assert.match(error.message,/independent installed bytes differ/);assert.equal(error.rawReads,1);assert.deepEqual(error.pushed,['main.js']);const witness=error.installReadbacks[0];assert.equal(witness.exactBytesMatched,false);assert.equal(witness.readAttempts,1);assert.equal(typeof witness.observedSha256,'string');assert.equal(JSON.stringify(witness).includes('private'),false);if(mode==='truncated')assert.equal(witness.expectedBytes-witness.observedBytes,1);if(['truncated','padded','changed'].includes(mode)){assert.equal(witness.remoteStorage.sha256,witness.expectedSha256);assert.equal(witness.appPidMatches,true);}if(mode.startsWith('diagnostics-'))assert.equal(witness.remoteStorage.result,'UNAVAILABLE');if(mode==='diagnostics-expire')assert.equal(error.shellReads,1);return true;});
  for(const mode of ['symlink','not-file','bad-format'])await assert.rejects(run(mode),error=>{assert.match(error.message,/candidate bytes differ/);assert.equal(error.sourceReads,0);assert.equal(error.rawReads,0);return true;});
  await assert.rejects(run('source-changed'),error=>{assert.match(error.message,/candidate bytes differ/);assert.equal(error.installReadbacks[0].exactBytesMatched,true);assert.equal(error.installReadbacks[0].sourceStillPinned,false);return true;});
  await assert.rejects(run('read-throws'),error=>{assert.equal(error.code,'ETIMEDOUT');assert.equal(error.rawReads,1);assert.equal(error.installReadbacks[0].observedBytes,null);return true;});
});

test('install process diagnostics report only bounded role states and never process commands or errors',async()=>{
  const source=(await import('node:fs')).readFileSync(new URL('./android-journey.mjs',import.meta.url),'utf8');
  const start=source.indexOf('  function installProcessFacts() {'),end=source.indexOf('\n  const receipts=[];',start);assert.ok(start>=0&&end>start);
  const state={holder:{pid:11,identity:'private holder command'},processes:{adb:{pid:12,identity:'private adb command'},emulator:{pid:13,identity:'private emulator command'}}};
  const probe=(command,args,options)=>{assert.equal(command,'ps');assert.equal(options.timeout,1000);if(args[1]==='11')return state.holder.identity+'\n';if(args[1]==='12')return 'different private command';throw Error('private probe failure');};
  const observe=new Function('execFileSync','state','usb','Date',source.slice(start,end)+';return installProcessFacts();');
  const facts=observe(probe,state,false,{now:()=>123});assert.deepEqual(facts,{atEpochMs:123,holder:'MATCH',adb:'CHANGED',emulator:'UNAVAILABLE'});assert.equal(JSON.stringify(facts).includes('private'),false);
  const usb=structuredClone(state);delete usb.processes.emulator;assert.equal(observe(probe,usb,true,{now:()=>123}).emulator,'NOT_APPLICABLE');assert.equal(observe(probe,usb,false,{now:()=>123}).emulator,'NOT_RECORDED');
});

test('owned root enumeration preserves exact entry bytes and requires complete bounded framing',()=>{
  const vault='/storage/emulated/0/Documents/Obsync-Entries',marker='OBSYNC_ROOT_ENTRIES_COMPLETE';
  const framed=names=>Buffer.from(names.map(n=>vault+'/'+n+'\0').join('')+marker+'\0');
  assert.deepEqual(parseOwnedRootEntries(vault,framed(['Team docs','team docs','literal\\ name','é\nname'])),['Team docs','team docs','literal\\ name','é\nname']);
  assert.deepEqual(parseOwnedRootEntries(vault,framed([])),[]);
  const good=framed(['Team docs']);
  const invalid=[Buffer.alloc(0),good.subarray(0,-1),Buffer.from(vault+'/Team docs\0'),Buffer.from(marker+'\0garbage\0'),Buffer.from('/foreign/Team docs\0'+marker+'\0'),Buffer.from(vault.replace('Entries','Foreign')+'/Team docs\0'+marker+'\0'),framed(['']),framed(['.']),framed(['..']),framed(['nested/entry']),framed(['Team docs','Team docs']),framed(Array.from({length:65},(_,i)=>'Entry'+i)),framed(['a'.repeat(65536)]),Buffer.concat([Buffer.from(vault+'/'),Buffer.from([0xff,0]),Buffer.from(marker+'\0')])];
  for(const bytes of invalid)assert.throws(()=>parseOwnedRootEntries(vault,bytes));
  assert.throws(()=>parseOwnedRootEntries('/foreign',good),/synthetic vault/);
  let calls=0;
  assert.deepEqual(readOwnedRootEntries((...argv)=>{calls++;assert.deepEqual(argv,['shell','-T',`find '${vault}' -mindepth 1 -maxdepth 1 -print0 && printf '${marker}\\000'`]);return good;},vault),['Team docs']);
  assert.equal(calls,1);
  assert.throws(()=>readOwnedRootEntries(()=>{throw Error('remote find failed');},vault),/remote find failed/);
  assert.throws(()=>readOwnedRootEntries(()=>Buffer.from(vault+'/Team docs\0'),vault),/completion absent/,'entry-boundary truncation must not prove old-name absence');
});

test('actual folder snapshot and rename verification use complete exact entries and preserve independent descendant guards',async()=>{
  const source=(await import('node:fs')).readFileSync(new URL('./android-journey.mjs',import.meta.url),'utf8');
  const start=source.indexOf("      stage='independent_folder_and_descendant_bytes';"),end=source.indexOf("    }else if(['history-baseline'",start);assert.ok(start>0&&end>start);
  const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
  const action=new AsyncFunction('command','input','state','evaluate','device','androidPathArg','androidExecPathArg','ownedVault','readOwnedRootEntries','digest','resolve','join','run','writeFileSync','privateJson','receipt','waitFolderIndex','let stage,folderIndexReadiness;'+source.slice(start,end));
  async function run(mode='exact',verify=false){
    const vault='/storage/emulated/0/Documents/Obsync-Entries',folder=verify?'team docs':'Team docs',run='/owned/run',state={sourceHead:'a'.repeat(40)},contents={'One.md':Buffer.from('independent ONE\n'),'Two.md':Buffer.from('independent TWO\n')};let output,receipts=[],shellReads=0,catReads=0;
    const files=Object.keys(contents).map((name,i)=>({path:folder+'/'+name,id:(i?'b':'a').repeat(32)}));
    const before={sourceHead:state.sourceHead,folder:'Team docs',files:files.map(f=>({suffix:f.path.slice(folder.length+1),bytes:contents[f.path.split('/')[1]].length,sha256:digest(contents[f.path.split('/')[1]]),fileIdHash:digest(Buffer.from(f.id))}))};
    if(mode==='changed-id')files[0].id='c'.repeat(32);
    if(mode==='changed-byte')contents['One.md']=Buffer.from('changed bytes');
    const input={vaultPath:vault,folder,output:run+'/private/folder-before-test.json',...(verify?{beforeSnapshot:run+'/private/folder-before-original.json',oldFolder:'Team docs'}:{})};
    const device=(...argv)=>{assert.notEqual(argv[1],'ls','rendered listings must never be consumed');if(argv[0]==='shell'&&argv[1]==='-T'){shellReads++;assert.ok(argv[2].includes('-maxdepth 1 -print0 &&'));let names=mode==='wrong-case'?['TEAM DOCS']:[folder];if(mode==='old-present')names.push('Team docs');const entries=names.map(n=>vault+'/'+n+'\0').join('');return Buffer.from(entries+(mode==='partial'?'':'OBSYNC_ROOT_ENTRIES_COMPLETE\0'));}if(argv[0]==='exec-out'){catReads++;assert.equal(argv[1],'cat');return contents[argv[2].split('/').at(-1)];}assert.deepEqual(argv,['shell','test','-d',androidPathArg(vault+'/'+folder)]);return Buffer.alloc(0);};
    await action(verify?'folder-verify':'folder-snapshot',input,state,async(body)=>body.includes('old folder remains indexed')?true:waitFolderIndex({vault:{getAbstractFileByPath:()=>({children:[]}),getMarkdownFiles:()=>files},plugins:{plugins:{'obsync-private-sync':{state:{fileByPath:path=>({fileId:files.find(f=>f.path===path).id})}}}}},folder),device,androidPathArg,androidExecPathArg,ownedVault,readOwnedRootEntries,digest,x=>x,(...parts)=>parts.join('/'),run,(_path,data)=>{output=JSON.parse(data);},()=>before,r=>receipts.push(r),waitFolderIndex);
    return {output,receipts,shellReads,catReads};
  }
  const snapshot=await run();assert.equal(snapshot.output.files.length,2);assert.equal(snapshot.catReads,2);assert.equal(snapshot.receipts[0].independentAdbBytes,true);
  const renamed=await run('exact',true);assert.equal(renamed.shellReads,2);assert.equal(renamed.receipts[0].descendantIdentityAndBytesPreserved,true);
  for(const [mode,reason] of [['wrong-case',/exact persisted folder case differs/],['partial',/completion absent/],['old-present',/old exact folder name remains persisted/],['changed-id',/renamed descendant identities or bytes differ/],['changed-byte',/renamed descendant identities or bytes differ/]])await assert.rejects(run(mode,true),reason);
});

test('actual folder freshness refuses exact existing files and incomplete absence, without consuming rendered ls',async()=>{
  const source=(await import('node:fs')).readFileSync(new URL('./android-journey.mjs',import.meta.url),'utf8');
  const guard=source.match(/        if\(readOwnedRootEntries\(device,base.vaultPath\)\.includes\(target\)\)throw Error\('fresh exact folder name required'\);/)?.[0];assert.ok(guard);
  const check=new Function('readOwnedRootEntries','device','base','target',guard);
  const vault='/storage/emulated/0/Documents/Obsync-Entries';
  const device=names=>(...argv)=>{assert.equal(argv[0],'shell');assert.equal(argv[1],'-T');return Buffer.from(names.map(n=>vault+'/'+n+'\0').join('')+'OBSYNC_ROOT_ENTRIES_COMPLETE\0');};
  assert.throws(()=>check(readOwnedRootEntries,device(['Team docs']),{vaultPath:vault},'Team docs'),/fresh exact folder name required/);
  check(readOwnedRootEntries,device(['team docs']),{vaultPath:vault},'Team docs');
  assert.throws(()=>check(readOwnedRootEntries,()=>Buffer.from(vault+'/other\0'),{vaultPath:vault},'Team docs'),/completion absent/);
});

test('actual selected boundaries require exact case, single folded entry and independent excluded bytes',async()=>{
  const source=(await import('node:fs')).readFileSync(new URL('./android-journey.mjs',import.meta.url),'utf8');
  const start=source.indexOf("      stage='verify_native_selected_folder_boundaries';"),end=source.indexOf("    }else if(command==='fixture-provision')",start);assert.ok(start>0&&end>start);
  const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
  const action=new AsyncFunction('input','ownedVault','readOwnedRootEntries','device','androidExecPathArg','androidPathArg','evaluate','receipt','process','let stage;'+source.slice(start,end));
  const vault='/storage/emulated/0/Documents/Obsync-Entries',text='independent outside bytes\n';
  async function run(names,changedBytes=false,partial=false){let result;const process={};const input={vaultPath:vault,folder:'Team docs',outsideLocal:'Outside/Phone-sentinel.md',outsideAbsent:'Outside/Sentinel.md',outsideText:text};
    const device=(...argv)=>{if(argv[0]==='exec-out')return Buffer.from(changedBytes?'wrong bytes':text);if(argv[1]==='-T')return Buffer.from(names.map(n=>vault+'/'+n+'\0').join('')+(partial?'':'OBSYNC_ROOT_ENTRIES_COMPLETE\0'));if(argv[1]?.startsWith('if test'))return Buffer.from('OBSYNC_TRASH_ABSENT\n');return Buffer.alloc(0);};
    await action(input,ownedVault,readOwnedRootEntries,device,androidExecPathArg,androidPathArg,async()=>({savedPolicyMatched:true,folderIndexed:true,localOutsideIndexed:true,localOutsideUntracked:true,foreignOutsideIndexAbsent:true}),r=>{result=r;},process);return {result,code:process.exitCode};}
  assert.equal((await run(['Team docs','Outside','.obsidian'])).result.result,'PASS');
  for(const [names,changed] of [[['team docs'],false],[['Team docs','team docs'],false],[['Team docs'],true]]){const refused=await run(names,changed);assert.equal(refused.result.result,'FAIL');assert.equal(refused.code,1);}
  await assert.rejects(run(['Team docs'],false,true),/completion absent/);
});

test('actual explicit case workflow requires two ordinary legs, fresh exact paths, original descendant baseline and one180s budget',async()=>{
  const source=(await import('node:fs')).readFileSync(new URL('./android-journey.mjs',import.meta.url),'utf8');
  assert.ok(source.includes("'folder-create','folder-rename','folder-case-rename','previous-history-restore'"));
  const start=source.indexOf("        // Explicit two ordinary renames:"),end=source.indexOf("      }else if(command==='folder-create'",start);assert.ok(start>0&&end>start);
  const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
  const action=new AsyncFunction('input','base','automaticAttempt','join','run','performance','readOwnedRootEntries','device','step','receipt','state','privateJson','Date','let stage;'+source.slice(start,end));
  async function run(mode='exact',reverse=false){
    let clock=0,root=[reverse?'team docs':'Team docs'],renameLegs=0,reads=0,verifiedOriginal=false,baseline,baselineReads=0,finalClockReads=0;const steps=[],receipts=[],notes=[{suffix:'One.md',sha256:'a'.repeat(64),fileIdHash:'b'.repeat(64)},{suffix:'Two.md',sha256:'c'.repeat(64),fileIdHash:'d'.repeat(64)}];
    if(mode==='empty')notes.length=0;
    const input={from:root[0],to:reverse?'Team docs':'team docs'},base={vaultPath:'/storage/emulated/0/Documents/Obsync-Entries'},original=root[0];
    if(mode==='collision')root.push('Obsync-case-rename');if(mode==='wrong-source')root=['TEAM DOCS'];if(mode==='existing-final')root.push(input.to);if(mode==='invalid-endpoint')input.to='Other folder';
    const read=()=>{reads++;if(mode==='late-initial-read')clock=180000;return [...root];};
    const step=async(name,command,data)=>{
      steps.push({name,command,data});clock+=mode==='fractional-clock'?100.1:100;
      if(command==='folder-snapshot'){assert.equal(data.folder,original);baseline={path:data.output,files:structuredClone(notes)};}
      else if(command==='folder-rename'){
        renameLegs++;assert.ok(root.includes(data.from));assert.ok(!root.includes(data.to));
        if(mode==='refusal')throw Error('ordinary UI refused');
        if(mode==='skip-first'&&renameLegs===1||mode==='skip-second'&&renameLegs===2)return;
        root=root.filter(n=>n!==data.from);root.push(mode==='wrong-final'&&renameLegs===2?'TEAM DOCS':data.to);
        if(mode==='intermediate-left'&&renameLegs===2)root.push('Obsync-case-rename');
        if(mode==='old-left'&&renameLegs===2)root.push(original);
        if(mode==='changed-id'&&renameLegs===2)notes[0].fileIdHash='e'.repeat(64);
        if(mode==='changed-byte'&&renameLegs===2)notes[0].sha256='e'.repeat(64);
        if(mode==='expired-first'&&renameLegs===1)clock=180000;
      }else if(command==='folder-verify'){
        assert.equal(data.folder,input.to);assert.equal(data.oldFolder,original);assert.equal(data.beforeSnapshot,baseline.path);assert.deepEqual(notes,baseline.files);verifiedOriginal=true;
        if(mode==='expired-final')clock=180000;
      }else throw Error('unexpected action');
    };
    const state={sourceHead:'a'.repeat(40)};
    const privateJson=path=>{baselineReads++;assert.equal(path,baseline.path);if(mode==='missing-baseline')throw Error('owned snapshot missing');const value={sourceHead:state.sourceHead,folder:original,files:structuredClone(baseline.files)};if(mode==='wrong-baseline-head')value.sourceHead='b'.repeat(40);if(mode==='wrong-baseline-folder')value.folder='Other';if(mode==='invalid-baseline-files')value.files='not an array';if(mode==='oversized-baseline-files')value.files=Array(33).fill({});if(mode==='changed-baseline'&&baselineReads===2)value.files=[];return value;};
    try{await action(input,base,'test',(...parts)=>parts.join('/'),'/owned/run',{now:()=>mode==='expired-final-measurement'&&verifiedOriginal&&++finalClockReads>=2?180000:clock},read,()=>{throw Error('unexpected raw call');},step,r=>receipts.push(r),state,privateJson,{now:()=>{throw Error('wall clock must not drive local deadline');}});}
    catch(error){error.steps=steps;error.renameLegs=renameLegs;error.receipts=receipts;error.clock=clock;throw error;}
    return {steps,receipts,renameLegs,verifiedOriginal,reads,clock};
  }
  for(const reverse of [false,true]){let pass;await assert.doesNotReject(async()=>{pass=await run('exact',reverse);});assert.equal(pass.renameLegs,2);assert.equal(pass.verifiedOriginal,true);assert.equal(pass.reads,3);assert.deepEqual(pass.steps.map(s=>s.command),['folder-snapshot','folder-rename','folder-rename','folder-verify']);assert.equal(pass.receipts.length,1);assert.equal(pass.receipts[0].descendants,2);assert.equal(pass.receipts[0].ordinaryRenameCount,2);assert.equal(pass.receipts[0].directSingleStepCaseRename,false);assert.equal(pass.receipts[0].sharedBudgetMs,180000);assert.equal(pass.receipts[0].elapsedMs,400);assert.equal(pass.receipts[0].workflow,'TWO_ORDINARY_RENAMES');assert.equal(pass.receipts[0].finalFolder,reverse?'Team docs':'team docs');for(const field of ['originalBaselinePreserved','intermediateAbsent','originalAbsent'])assert.equal(pass.receipts[0][field],true);}
  let empty;await assert.doesNotReject(async()=>{empty=await run('empty');});assert.equal(empty.verifiedOriginal,true);assert.equal(empty.receipts[0].descendants,0);
  assert.equal((await run('fractional-clock')).receipts[0].elapsedMs,400);
  for(const mode of ['missing-baseline','wrong-baseline-head','wrong-baseline-folder','invalid-baseline-files','oversized-baseline-files','changed-baseline','collision','wrong-source','existing-final','invalid-endpoint','skip-first','skip-second','intermediate-left','old-left','wrong-final','refusal','changed-id','changed-byte','late-initial-read','expired-first','expired-final','expired-final-measurement'])await assert.rejects(run(mode),error=>{assert.equal(error.receipts.length,0);if(['collision','wrong-source','existing-final','invalid-endpoint','late-initial-read'].includes(mode))assert.equal(error.steps.length,0);if(mode==='skip-first'||mode==='expired-first'||mode==='refusal')assert.equal(error.renameLegs,1);if(mode.startsWith('expired')||mode==='late-initial-read')assert.match(error.message,/ordinary folder case rename deadline/);return true;});
});
