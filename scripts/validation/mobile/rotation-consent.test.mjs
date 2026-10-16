// Offline current-generation proof/control fixtures, never native acceptance.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,realpathSync,rmSync,writeFileSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {join,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {recordContext} from './ciphertext-oracle.mjs';
import {rotationProofBinding,partitionRotationRecords,checkpointBytes} from './known-notes-proof.mjs';
import {inventoryHeads,inventoryHash,readNativeCheckpoint} from './native-checkpoint.mjs';
import {digest,privateRead,privateSave} from './desktop-guard.mjs';
import {rotationPairObservation,waitRotationPair,waitPairConsentOutcome,knownNotesMatch} from '../android-journey.mjs';
const hex=(c,n=32)=>c.repeat(n),equal=(a,b)=>assert.deepEqual(a,b);
function fixture(){
 const records=['1','2','3'].map(c=>({fileId:hex(c),heads:[hex(c,64)],versions:[hex(c,64)]}));
 const intent={operation:hex('a'),previous_map:hex('1'),current_map:hex('4'),target:hex('b'),recovery_verifier:hex('c',64),seal_suite:2};
 const draft={schema:1,sourceHead:hex('a',40),phase:'draft',generation:hex('4'),rotation:{intent,coordinator:hex('d'),fromSuite:2,prepared:null,commit:null},notes:[{path:'One.md',fileId:hex('2')}],disk:[{path:'One.md',sha256:hex('e',64)}],records,engineState:'ABSENT'};
 const heads=inventoryHeads(records),hash=inventoryHash(heads),prepared={cutoff:42,inventoryHash:hash,inventoryHeads:3},commitReceipt={catalogPages:1,catalogHash:hex('7',64)};
 const destinations=records.map((r,i)=>[r.fileId,hex(String(i+4))]);
 const status={intent,coordinator:hex('d'),cutoff:42,inventory_hash:hash,inventory_heads:3,catalog_pages:1,catalog_heads:3,catalog_last:heads.at(-1),catalog_hash:hex('7',64),committed:false};
 const commit={...structuredClone(draft),phase:'commit_unknown',rotation:{...structuredClone(draft.rotation),prepared,commit:commitReceipt},records:[...structuredClone(records),...destinations.map(([,id])=>({fileId:id,heads:[id+id],versions:[id+id]}))],destinations,rotationStatus:status,decoderHash:hex('8',64)};
 const context={sourceHead:draft.sourceHead,generation:hex('4'),decoderHash:commit.decoderHash},keys={fileId:hex('4'),domainId:hex('9')},domain=hex('f');
 const captured={files:commit.records.map(r=>({file_id:r.fileId,domain_id:records.some(old=>old.fileId===r.fileId)?hex('0'):r.fileId===keys.fileId?keys.domainId:domain,heads:r.heads,versions:r.versions.map(version_id=>({version_id}))}))};
 captured.records=captured.files.map(f=>({...f.versions[0],file_id:f.file_id,domain_id:f.domain_id}));
 const seal=()=>{
  const draftText=JSON.stringify(draft),commitText=JSON.stringify(commit);
  const receipt=(label,result,text)=>({schema:1,label,result,sourceHead:context.sourceHead,checkpointSha256:digest(text),generationHash:digest(context.generation)});
  return {draftText,commitText,draftReceipt:receipt('rotation-draft','OBSERVED',draftText),commitReceipt:receipt('commit-after','PASS',commitText)};
 };
 const bind=()=>{const s=seal();return rotationProofBinding(s.draftText,s.commitText,s.draftReceipt,s.commitReceipt,context);};
 return {draft,commit,context,keys,domain,captured,seal,bind};
}
test('replacement no-prompt partition authenticates both checkpoint receipts and exact frozen operation',()=>{
 const f=fixture();const bound=f.bind();assert.equal(bound.commit.phase,'commit_unknown');
 for(const change of [f=>f.context.sourceHead=hex('b',40),f=>f.context.generation=hex('b'),f=>f.context.decoderHash=hex('b',64),f=>f.commit.rotation.intent.operation=hex('b'),f=>f.commit.rotationStatus.inventory_hash=hex('b',64),f=>f.commit.rotationStatus.catalog_hash=hex('b',64),f=>f.commit.engineState='RUNNING',f=>f.commit.phase='active',f=>f.commit.records.pop()]){const x=fixture();change(x);assert.throws(x.bind);}
 for(const field of ['draftReceipt','commitReceipt'])for(const change of [r=>r.checkpointSha256=hex('b',64),r=>r.sourceHead=hex('b',40),r=>r.result='FAIL',r=>r.schema=0,r=>r.generationHash=hex('b',64),r=>r.label='another']){
  const f=fixture(),s=f.seal();change(s[field]);assert.throws(()=>rotationProofBinding(s.draftText,s.commitText,s.draftReceipt,s.commitReceipt,f.context));
 }
 const s=f.seal();assert.throws(()=>rotationProofBinding(s.draftText,s.commitText,{},s.commitReceipt,f.context));assert.throws(()=>rotationProofBinding('not JSON',s.commitText,s.draftReceipt,s.commitReceipt,f.context));
});
test('only pinned unchanged old IDs are excluded; all destinations and every additional current-domain record remain required',()=>{
 const f=fixture(),binding=f.bind();const partition=partitionRotationRecords(binding,f.captured,f.keys,f.domain,f.commit.destinations);
 equal(partition.records.map(r=>r.file_id),f.commit.destinations.map(r=>r[1]));assert.equal(partition.excludedPreviousFileCount,3);assert.equal(partition.rotationCheckpointSha256,digest(JSON.stringify(f.commit)));
 for(const mutate of [
  f=>{f.captured.files.pop();f.captured.records.pop();},
  f=>f.captured.files[0].heads=[hex('b',64)],
  f=>f.captured.files[0].versions.push({version_id:hex('b',64)}),
  f=>f.captured.records.pop(),f=>f.captured.records.push(f.captured.records[0]),
  f=>{f.captured.files.push({file_id:hex('e'),domain_id:hex('0'),heads:[hex('e',64)],versions:[{version_id:hex('e',64)}]});f.captured.records.push({file_id:hex('e'),domain_id:hex('0'),version_id:hex('e',64)});},
  f=>f.captured.records.find(r=>r.file_id===f.keys.fileId).domain_id=hex('e')]){
  const x=fixture();mutate(x);assert.throws(()=>partitionRotationRecords(x.bind(),x.captured,x.keys,x.domain,x.commit.destinations));
 }
 const wrong=fixture();const plan=structuredClone(wrong.commit.destinations);plan[1][1]=hex('b');assert.throws(()=>partitionRotationRecords(wrong.bind(),wrong.captured,wrong.keys,wrong.domain,plan));
 const swapped=fixture(),different=structuredClone(swapped.commit.destinations);[different[1][1],different[2][1]]=[different[2][1],different[1][1]];assert.throws(()=>partitionRotationRecords(swapped.bind(),swapped.captured,swapped.keys,swapped.domain,different));
 const extra={file_id:hex('e'),domain_id:f.domain,heads:[hex('e',64)],versions:[{version_id:hex('e',64)}]};f.captured.files.push(extra);f.captured.records.push({...extra.versions[0],file_id:extra.file_id,domain_id:extra.domain_id});assert.equal(partitionRotationRecords(binding,f.captured,f.keys,f.domain,f.commit.destinations).records.length,4);
});
test('existing no-consent admission still requires independently exact NEW path, file ID and persisted-byte hashes',()=>{
 const f=fixture(),partition=partitionRotationRecords(f.bind(),f.captured,f.keys,f.domain,f.commit.destinations),file={path:'One.md',fileIdHash:digest(partition.records[1].file_id),sha256:digest('known bytes')};
 const context={sourceHead:f.context.sourceHead,generationHash:digest(f.keys.fileId),invitationTime:20,now:30},proof={schema:1,sourceHead:context.sourceHead,generationHash:context.generationHash,completeServerInventory:true,observedAt:10,files:[file]};
 assert.equal(knownNotesMatch(proof,context,[file]),true);
 for(const row of [{...file,fileIdHash:digest(f.draft.notes[0].fileId)},{...file,sha256:digest('wrong bytes')},{...file,path:'Foreign.md'}])assert.throws(()=>knownNotesMatch(proof,context,[row]));
});
const good=()=>({statePresent:true,paired:true,suite2:true,phase:'active',generationValid:true,currentGenerationMatched:true,oldGenerationStillHeld:false,historyPresent:true,historySuite2:true,historyGenerationMatched:true,enrollmentPresent:false,rotationPending:false,forgottenDevice:false,waitingHandlePresent:false,consentVisibleCount:0,claimantVisibleCount:0,otherModalCount:0});
test('status observes bounded staged consent/forgotten/custody facts and retains strict history/generation within original20s',async()=>{
 let clock=0,reads=0;const facts={};const staged={...good(),paired:false,phase:'enrollment',enrollmentPresent:true,waitingHandlePresent:true,consentVisibleCount:1};
 await waitRotationPair(async budget=>{assert.ok(budget<=5000&&budget<=20000-clock);return ++reads===1?staged:good();},facts,async ms=>{clock+=ms;},()=>clock);assert.equal(facts.ready,true);assert.equal(facts.before.consentVisibleCount,1);assert.equal(facts.after.phase,'active');
 clock=0;const waiting={};await waitRotationPair(async()=>({...staged,forgottenDevice:true}),waiting,async ms=>{clock+=ms;},()=>clock);assert.equal(waiting.ready,false);assert.equal(clock,20000);assert.equal(waiting.after.forgottenDevice,true);assert.equal(waiting.after.historyPresent,true);
 for(const delta of [{currentGenerationMatched:false,oldGenerationStillHeld:false},{historyGenerationMatched:false},{historySuite2:false},{generationValid:false},{statePresent:false}]){const refused={};await waitRotationPair(async()=>({...good(),...delta}),refused,async()=>assert.fail('wrong present facts cannot wait'),()=>0);assert.equal(refused.refused,true);assert.equal(refused.ready,false);}
 clock=0;const late={};await waitRotationPair(async()=>{clock=20001;return good();},late,async()=>{},()=>clock);assert.equal(late.ready,false);
});
test('read-only replacement observation reduces DOM and custody to fixed labels, booleans and counts',async()=>{
 const gen=hex('4'),old=hex('1'),pin={phase:'enrollment',suite:2,generation:gen,history:{generation:old,suite:2},enrollment:{root:'private root never exported'}};
 const app={plugins:{plugins:{'obsync-private-sync':{state:{paired:false,custody2:()=>pin},forgottenDevice:true,waiting:{private:'invitation'}}}}};
 const saved=globalThis.document;globalThis.document={querySelectorAll:()=>[{getBoundingClientRect:()=>({width:1,height:1}),querySelector:()=>({textContent:"Add this vault's notes to the server's vault?"})},{getBoundingClientRect:()=>({width:1,height:1}),querySelector:()=>({textContent:'private unknown title'})}]};
 try{const facts=await rotationPairObservation(app,{current:digest(gen),old:digest(old)});assert.equal(facts.phase,'enrollment');assert.equal(facts.forgottenDevice,true);assert.equal(facts.consentVisibleCount,1);assert.equal(facts.otherModalCount,1);assert.equal(facts.historyGenerationMatched,true);assert.equal(JSON.stringify(facts).includes('private'),false);}finally{globalThis.document=saved;}
});
test('actual replacement runner produces proof BEFORE invitation, observes ordinary conditional consent AFTER independent approval, then checks retained history',()=>{
 const source=readFileSync(new URL('../mobile-full.py',import.meta.url),'utf8');const first=source.indexOf("    archive_pair('access')"),end=source.indexOf("    phone_reads('rotated-desktop-note-received'",first);assert.ok(first>0&&end>first);const block=source.slice(first,end).split('\n').map(line=>line.startsWith('    ')?line.slice(4):line).join('\n');
 const run=code=>spawnSync('python3',['-B','-c',`from pathlib import Path\nproof=False\napproved=False\nconsented=False\ninvited=False\nnode='node';source='source';desktop=Path('/synthetic');invitation=desktop/'invitation';lab={'mobileUrl':'https://synthetic.invalid'}\nnew_status={'generationHash':'new'};old_status={'generationHash':'old'}\ndef archive_pair(*args): pass\ndef helper(name): return name\nclass Steps:\n def run(self,stage,args):\n  global proof\n  assert not invited and args[-2:]==['--rotation-proof','commit-after'] and args[args.index('--backup')+1]=='new'\n  proof=True\nsteps=Steps()\ndef desk(stage,command):\n global invited\n assert proof;invited=True\ndef compare_approve(label):\n global approved\n assert invited;approved=True\ndef phone(stage,command,data,*args):\n global consented\n if command=='pair-consent':\n  assert approved and proof and data['expectedGenerationHash']=='new' and data['expectedOldGenerationHash']=='old' and data['knownNotesProof'].endswith('known-notes-rotation-repair.json')\n  consented=True\n if command=='rotation-pair-status': assert consented and data['expectedOldGenerationHash']=='old'\n${code}\nassert proof and approved and consented\n`],{encoding:'utf8'});
 assert.equal(run(block).status,0);const line="phone('rotation-repair-local-consent', 'pair-consent', {'expectedGenerationHash': new_status['generationHash'], 'expectedOldGenerationHash': old_status['generationHash'], 'invitationFile': str(invitation),\n    'knownNotesProof': str(desktop / 'private/desktop/known-notes-rotation-repair.json')})\n";assert.ok(block.includes(line));assert.notEqual(run(block.replace(line,'')).status,0);
});

test('actual producer current-note loop must authenticate every included record/chunk and independent disk bytes',async()=>{
 const source=resolve(process.env.OBSYNC_ORACLE_SOURCE??fileURLToPath(new URL('../../../..',import.meta.url))),require=createRequire(join(source,'plugin/package.json'));
 const api={c:require('./build/crypto.js'),seal:require('./build/seal2.js'),dm:require('./build/domainmap.js'),wire:require('./build/sealWire.js')};
 const root=new Uint8Array(32).fill(22),keys=await api.dm.domainMapKeys(root),domainId=hex('a'),domain=await api.c.deriveDomainKey(root,domainId),manifestKey=await api.c.deriveManifestKey(domain,domainId),text='# Synthetic known note\n',path='One.md';
 const chunk=await api.seal.encryptChunk2(domain,{generation:keys.fileId,domainId},api.c.utf8(text));
 const entry={v:1,path,domain:domainId,mtime:1,size:Buffer.byteLength(text),sha256:digest(text),chunks:[{sid:chunk.sid,cid:api.c.hex(chunk.cid),len:Buffer.byteLength(text)}],deleted:false};
 const base={file_id:hex('b'),domain_id:domainId,generation:keys.fileId,parents:[],sids:[chunk.sid],bytes:Buffer.byteLength(text),seal_suite:2,deleted:false};
 const ct=await api.seal.sealRecord(manifestKey,1,recordContext(base),api.c.utf8(JSON.stringify(entry)));base.manifest_ct=api.c.base64(ct);base.version_id=await api.c.versionId(base.file_id,base.parents,ct,base.sids);
 const code=readFileSync(new URL('./known-notes-proof.mjs',import.meta.url),'utf8');const first=code.indexOf('  for(const record of partition.records){'),last=code.indexOf('  check(files.length>0',first);assert.ok(first>0&&last>first);
 const AsyncFunction=Object.getPrototypeOf(async()=>{}).constructor,run=new AsyncFunction('partition','keys','api','domainId','manifestKey','domain','map','client','state','readFileSync','owned','check','digest','recordContext','join','const files=[],ciphertextHashes=[];'+code.slice(first,last)+'return files;');
 const execute=async({record=base,body=chunk.ciphertext,disk=text}={})=>run({records:[record]},keys,api,domainId,manifestKey,domain,api.dm.defaultDomainMap(domainId),{evaluate:async()=>Array.from(body)},{devices:{A:{vault:'/synthetic'}}},()=>Buffer.from(disk),()=>{},(v,reason)=>{if(!v)throw Error(reason);},digest,recordContext,join);
 const files=await execute();assert.equal(files.length,1);equal(files[0],{path,sha256:digest(text),fileIdHash:digest(base.file_id)});
 for(const [options,reason] of [[{record:{...base,domain_id:hex('f')}},/current_domain_inventory/],[{record:{...base,version_id:hex('f',64)}},/manifest_version_hash/],[{record:{...base,manifest_ct:api.c.base64(new Uint8Array(ct.length))}},/manifest_version_hash/],[{body:new Uint8Array(chunk.ciphertext.length)},/chunk_hash/],[{disk:'wrong bytes'},/retained_disk_bytes/]])await assert.rejects(execute(options),reason);
});

test('actual proof partition wiring re-derives destinations from old metadata and preserves complete before/after head equality',async()=>{
 const code=readFileSync(new URL('./known-notes-proof.mjs',import.meta.url),'utf8'),first=code.indexOf('  if(binding){'),last=code.indexOf('  const files=[],ciphertextHashes=',first);assert.ok(first>0&&last>first);
 const AsyncFunction=Object.getPrototypeOf(async()=>{}).constructor;
 const run=new AsyncFunction('binding','api','privateRead','join','state','captured','inventoryHeads','deriveCheckpointDestinations','root','partitionRotationRecords','keys','domainId','let partition;'+code.slice(first,last)+'return partition;');
 const f=fixture(),binding=f.bind(),oldRoot={synthetic:'old'},newRoot={synthetic:'new'};let derives=0;
 const partition=await run(binding,{backup:{parseRecoveryBackup:async text=>{assert.equal(text,'complete synthetic old backup');return oldRoot;}}},path=>{assert.equal(path,'/synthetic/phone-old-recovery-backup.txt');return 'complete synthetic old backup';},join,{secrets:'/synthetic'},f.captured,inventoryHeads,async(_api,draft,files,inventory,old,next)=>{derives++;assert.equal(draft,binding.draft);assert.equal(files,f.captured.files);equal(inventory,inventoryHeads(draft.records));assert.equal(old,oldRoot);assert.equal(next,newRoot);return f.commit.destinations;},newRoot,partitionRotationRecords,f.keys,f.domain);
 assert.equal(derives,1);assert.equal(partition.excludedPreviousFileCount,3);
 const after=code.slice(code.indexOf('  check(files.length>0'));const body=/await client.evaluate\(`([\s\S]*?)`,\{generation:keys.fileId,heads:captured.heads\}\);/.exec(after)?.[1];assert.ok(body);
 const read=new AsyncFunction('app','P',body),files=f.captured.files.map(file=>({file_id:file.file_id,heads:file.heads})),heads=files.map(file=>[file.file_id,[...file.heads].sort()]).sort((a,b)=>a[0].localeCompare(b[0])),page={files,next:null};
 const app={plugins:{plugins:{'obsync-private-sync':{state:{custody2:()=>({generation:f.keys.fileId})},currentStatus:()=>({kind:'idle'}),transport:{listFiles:async()=>page}}}}};
 assert.equal(await read(app,{generation:f.keys.fileId,heads}),true);page.files=[...files,{file_id:hex('e'),heads:[hex('e',64)]}];await assert.rejects(read(app,{generation:f.keys.fileId,heads}),/inventory changed/);
});

test('actual replacement consent observation waits for old pairing and shares its existing deadline with later index admission',async()=>{
 const old={...good(),currentGenerationMatched:false,oldGenerationStillHeld:true,historyPresent:false,historySuite2:false,historyGenerationMatched:false},staged={...good(),paired:false,phase:'enrollment',enrollmentPresent:true,consentVisibleCount:1},facts={};let clock=0,reads=0,indexReads=0,consentClicks=0;
 await waitPairConsentOutcome(async()=>{reads++;assert.equal(indexReads,0);assert.equal(consentClicks,0);return reads===1?old:staged;},facts,true,async ms=>{clock+=ms;},()=>clock,20000);
 assert.equal(facts.ready,true);assert.equal(facts.polls,2);assert.equal(facts.before.oldGenerationStillHeld,true);assert.equal(facts.after.phase,'enrollment');assert.equal(clock,100);
 const adoptedWithoutHistory={};await waitPairConsentOutcome(async()=>({...good(),historyPresent:false,historySuite2:false,historyGenerationMatched:false}),adoptedWithoutHistory,true,async()=>assert.fail('NEW paired outcome should be observed'),()=>0,20000);assert.equal(adoptedWithoutHistory.ready,true,'retained history is independently required by the next status gate');
 const wrong={};await waitPairConsentOutcome(async()=>({...old,oldGenerationStillHeld:false}),wrong,true,async()=>assert.fail('unrelated generation cannot wait'),()=>0,20000);assert.equal(wrong.refused,true);
 clock=0;const pending={};await waitPairConsentOutcome(async()=>({...old,forgottenDevice:true}),pending,true,async ms=>{clock+=ms;},()=>clock,20000);assert.equal(clock,20000);assert.equal(pending.ready,false);assert.equal(pending.after.forgottenDevice,true);
 const code=readFileSync(new URL('../android-journey.mjs',import.meta.url),'utf8');const first=code.indexOf('      const approvalOutcomeDeadline='),last=code.indexOf('      if(prior.paired){',first),body=code.slice(first,last);assert.ok(first>0&&last>first);
 const AsyncFunction=Object.getPrototypeOf(async()=>{}).constructor,action=new AsyncFunction('Date','input','waitPairConsentOutcome','evaluate','rotationPairObservation','let pairingReadiness;'+body+'return {approvalOutcomeDeadline,approvalReadiness,prior};');
 clock=0;reads=0;const boundWait=(read,facts,replacement,_pause,now,end)=>waitPairConsentOutcome(read,facts,replacement,async ms=>{clock+=ms;},now??(()=>clock),end);
 const result=await action({now:()=>clock},{expectedGenerationHash:'new',expectedOldGenerationHash:'old'},boundWait,async(_body,params,_owned,budget)=>{assert.equal(params.old,'old');assert.ok(budget<=20000-clock);reads++;return reads===1?old:good();},rotationPairObservation);
 assert.equal(result.approvalOutcomeDeadline,20000);assert.equal(result.prior.paired,true);assert.equal(result.approvalReadiness.before.oldGenerationStillHeld,true);assert.equal(clock,100);assert.ok(code.includes('approvalOutcomeDeadline-Date.now()'));
});

test('persisted checkpoint byte pins include privateSave newline and refuse trimmed, changed, absent or malformed evidence',()=>{
 const dir=realpathSync(mkdtempSync(join(tmpdir(),'obsync-checkpoint-byte-pin-')));
 try{
  const f=fixture(),draftPath=join(dir,'draft.json'),commitPath=join(dir,'commit.json');
  privateSave(draftPath,JSON.stringify(f.draft));privateSave(commitPath,JSON.stringify(f.commit));
  const draftBytes=checkpointBytes(draftPath),commitBytes=checkpointBytes(commitPath);assert.ok(Buffer.isBuffer(draftBytes));assert.equal(draftBytes.at(-1),10);assert.equal(commitBytes.at(-1),10);
  const receipt=(label,result,bytes)=>({schema:1,label,result,sourceHead:f.context.sourceHead,checkpointSha256:digest(bytes),generationHash:digest(f.context.generation)});
  const draftReceipt=receipt('rotation-draft','OBSERVED',draftBytes),commitReceipt=receipt('commit-after','PASS',commitBytes);
  const binding=rotationProofBinding(draftBytes,commitBytes,draftReceipt,commitReceipt,f.context);assert.equal(binding.commit.generation,f.context.generation);assert.equal(binding.checkpointSha256,digest(commitBytes));
  // Execute the actual producer load block, so replacing its raw input calls
  // with the formerly trimmed privateRead recipe is itself a broken control.
  mkdirSync(join(dir,'evidence'),{mode:0o700});
  writeFileSync(join(dir,'checkpoint-rotation-draft.json'),draftBytes,{mode:0o600});writeFileSync(join(dir,'checkpoint-commit-after.json'),commitBytes,{mode:0o600});
  privateSave(join(dir,'evidence/native-checkpoint-rotation-draft.json'),JSON.stringify(draftReceipt));privateSave(join(dir,'evidence/native-checkpoint-commit-after.json'),JSON.stringify(commitReceipt));
  const code=readFileSync(new URL('./known-notes-proof.mjs',import.meta.url),'utf8'),first=code.indexOf('  let binding=null;'),last=code.indexOf("  client=await connect(state,'A');",first);assert.ok(first>0&&last>first);
  const load=new Function('options','state','keys','api','join','rotationProofBinding','checkpointBytes','privateRead',code.slice(first,last)+'return binding;');
  const observed=load({'rotation-proof':'commit-after'},{secrets:dir,run:dir,source_head:f.context.sourceHead},{fileId:f.context.generation},{decoderHash:f.context.decoderHash},join,rotationProofBinding,checkpointBytes,privateRead);assert.equal(observed.checkpointSha256,digest(commitBytes));

  // Exact former runtime recipe: privateRead strips the serialized newline.
  assert.throws(()=>rotationProofBinding(privateRead(draftPath),privateRead(commitPath),draftReceipt,commitReceipt,f.context),/rotation_checkpoint_provenance/);
  for(const change of [bytes=>Buffer.concat([bytes,Buffer.from(' ')]),bytes=>bytes.subarray(0,bytes.length-1)])assert.throws(()=>rotationProofBinding(draftBytes,change(commitBytes),draftReceipt,commitReceipt,f.context),/rotation_checkpoint_provenance/);
  assert.throws(()=>checkpointBytes(join(dir,'missing.json')));writeFileSync(commitPath,'malformed JSON\n',{mode:0o600});assert.throws(()=>rotationProofBinding(draftBytes,checkpointBytes(commitPath),draftReceipt,commitReceipt,f.context));
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('actual production State/checkpoint retain NEW pending generation while the credential root stays OLD until activation',async()=>{
 const source=resolve(process.env.OBSYNC_ORACLE_SOURCE??fileURLToPath(new URL('../../../..',import.meta.url))),require=createRequire(join(source,'plugin/package.json'));
 const {fakeState}=await import(pathToFileURL(join(source,'plugin/test/fake.mjs'))),{accountRecovery}=require('./build/accountRecovery.js'),c=require('./build/crypto.js'),dm=require('./build/domainmap.js');
 const {state,reload}=await fakeState(),oldRoot=state.data.vrk,oldGeneration=state.custody2().generation,newRoot=c.hex(new Uint8Array(32).fill(22)),newGeneration=(await dm.domainMapKeys(c.unhex(newRoot))).fileId;
 assert.notEqual(oldGeneration,newGeneration);assert.notEqual(oldRoot,newRoot);
 const intent={lineage:hex('a'),operation:hex('b'),oldGeneration,newGeneration,targetDeviceId:hex('c'),recoveryVerifier:(await accountRecovery(newRoot)).verifier};
 await state.stageRotation(newRoot,intent);
 const assertPending=()=>{assert.equal(state.custody2().generation,newGeneration);assert.equal(state.custody2().rotation.intent.oldGeneration,oldGeneration);assert.equal(state.custody2().rotation.intent.newGeneration,newGeneration);assert.equal(state.data.vrk,oldRoot);};
 assertPending();await state.rotationPhase('prepare_unknown');await state.markRotationPrepared({cutoff:42,inventoryHash:hex('8',64),inventoryHeads:3});assertPending();await state.rotationPhase('seeding');await state.markRotationCommit({catalogPages:1,catalogHash:hex('9',64)});assertPending();
 const again=await reload();assert.equal(again.custody2().phase,'commit_unknown');assert.equal(again.custody2().generation,newGeneration);assert.equal(again.data.vrk,oldRoot);
 const ids=[oldGeneration,hex('d'),hex('e')],files=ids.map(id=>({file_id:id,heads:[id+id],versions:[{version_id:id+id}]}));
 const status={inventory_heads:3},app={plugins:{plugins:{'obsync-private-sync':{state:again,engine:null,currentStatus:()=>({kind:'idle'}),transport:{rotationStatus:async()=>status,rotationInventory:async()=>({heads:ids.map(id=>[id,id+id])}),getFile:async id=>files.find(file=>file.file_id===id)}}}}};
 const observed=await readNativeCheckpoint(app,{url:again.data.serverUrl,pending:true,ids,notes:[]});assert.equal(observed.ok,true);assert.equal(observed.generation,newGeneration);assert.equal(digest(observed.generation),digest(newGeneration));assert.notEqual(digest(observed.generation),digest(oldGeneration));
 await again.activateRotation();assert.equal(again.data.vrk,newRoot);assert.equal(again.custody2().generation,newGeneration);assert.equal(again.custody2().history.generation,oldGeneration);
});
