import test from 'node:test';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { waitKnownNotesIndex,waitCandidateReadiness,waitScopeSave,waitPairingActivation,serverUrlCommitMatched,pointerWitnessMatches,androidExecPathArg,persistedByteFacts,freshTrustRoute, comparison, ordinaryControl, ownedVault, visibleComparisons, safeExceptionMessage, knownNotesMatch, selectAllText,nativeScreen,androidPathArg,externalFailure,nativeReadiness,waitNativeReadiness,syntheticNotePath,candidateLabelMatches,restoredSiblingPath,pointerTarget,waitPointerReadiness,waitOwnedPage } from './android-journey.mjs';

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
