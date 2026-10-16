// Authenticated, bounded, read-only retained-peer inventory. Detached candidate
// crypto opens server bytes; no native engine/store/transport mutation or keys
// returned from the renderer. Run BEFORE generating the next invitation.
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {CheckpointFailure,assertFrozenInventory,assertDestinations,inventoryHeads,checkpointRecords,deriveCheckpointDestinations} from './native-checkpoint.mjs';
import {boundManifest,owned,privateRead,privateSave,digest} from './desktop-guard.mjs';
import {connect} from './cdp.mjs';
import {candidateCrypto,recordContext,OracleFailure} from './ciphertext-oracle.mjs';

const check=(value,code)=>{if(!value)throw new OracleFailure(code);};
// Receipt hashes cover the persisted bytes, including privateSave's newline.
// privateRead trims textual values and therefore cannot verify this byte pin.
export function checkpointBytes(path){
  check(owned(path).size<=2097152,'rotation_checkpoint_bound');
  return readFileSync(path);
}
export function rotationProofBinding(draftText,commitText,draftReceipt,commitReceipt,context){
  const draft=JSON.parse(draftText),commit=JSON.parse(commitText);
  for(const [name,proof,receipt,text,result]of [['rotation-draft',draft,draftReceipt,draftText,'OBSERVED'],['commit-after',commit,commitReceipt,commitText,'PASS']]){
    check(receipt?.schema===1&&receipt.result===result&&receipt.label===name&&receipt.sourceHead===context.sourceHead&&proof?.sourceHead===context.sourceHead&&receipt.checkpointSha256===digest(text)&&receipt.generationHash===digest(context.generation),'rotation_checkpoint_provenance');
  }
  check(commit.phase==='commit_unknown'&&commit.generation===context.generation&&commit.decoderHash===context.decoderHash,'rotation_checkpoint_generation');
  assertFrozenInventory(draft,commit,commit.rotationStatus,inventoryHeads(draft.records));assertDestinations(draft,commit,commit.destinations);
  return {draft,commit,checkpointSha256:digest(commitText)};
}
export function partitionRotationRecords(binding,captured,keys,domainId,derived){
  const {draft,commit}=binding;
  check(JSON.stringify(derived)===JSON.stringify(commit.destinations),'rotation_destination_plan');
  const records=checkpointRecords(captured.files),oldIds=new Set(draft.records.map(r=>r.fileId)),ids=new Set(records.map(r=>r.fileId));
  check(derived.every(row=>ids.has(row[1])),'rotation_current_union_incomplete');
  check(JSON.stringify(checkpointRecords(captured.sourceFiles))===JSON.stringify(draft.records),'rotation_old_histories_changed');
  check(!records.some(r=>oldIds.has(r.fileId)),'rotation_source_in_current_listing');
  check(captured.records.length===records.length&&new Set(captured.records.map(r=>r.file_id)).size===records.length&&captured.records.every(r=>ids.has(r.file_id)),'rotation_head_records_incomplete');
  const current=captured.records;
  check(current.every(r=>r.file_id===keys.fileId?r.domain_id===keys.domainId:r.domain_id===domainId),'rotation_unpinned_or_foreign_record');
  return {records:current,pinnedPreviousFileCount:oldIds.size,rotationCheckpointSha256:binding.checkpointSha256};
}
// The ordinary listing is generation-scoped. Read only frozen previous IDs
// directly for the source proof; they are never made part of the current page.
export async function readKnownInventory(app,P){
  let stage='native_state';
  try{
    const p=app.plugins.plugins['obsync-private-sync'],pin=p?.state?.custody2(),ctx=p?.engine?.contextValue;
    if(!p?.state?.paired||p.state.data.serverUrl!==P.url||pin?.suite!==2||pin.phase!=='active'||pin.rotation||!ctx||ctx.generation!==P.generation||pin.generation!==P.generation||p.currentStatus().kind!=='idle')throw Error('refused');
    stage='current_listing';const page=await p.transport.listFiles(null,{interactive:true});
    if(page.next!==null||page.files.length<1||page.files.length>32)throw Error('refused');
    const heads=page.files.map(f=>[f.file_id,[...f.heads].sort()]).sort((a,b)=>a[0].localeCompare(b[0])),records=[],files=[],sourceFiles=[];
    const read=async id=>{const file=await p.transport.getFile(id,{interactive:true});if(file.file_id!==id||!Array.isArray(file.heads)||!Array.isArray(file.versions)||file.versions.length>128||JSON.stringify(file).length>1048576)throw Error('refused');return file;};
    stage='current_files';
    for(const item of page.files){
      if(!/^[a-f0-9]{32}$/.test(item.file_id)||item.heads.length!==1)throw Error('refused');
      const file=await read(item.file_id);
      if(JSON.stringify([...file.heads].sort())!==JSON.stringify([...item.heads].sort()))throw Error('refused');
      files.push(file);const head=file.versions.find(v=>v.version_id===item.heads[0]);
      if(!head||head.seal_suite!==2||head.sids.length>1||head.bytes>16384)throw Error('refused');
      records.push({...head,file_id:file.file_id,domain_id:file.domain_id,generation:P.generation});
    }
    stage='pinned_source_files';
    if(!Array.isArray(P.sourceIds)||P.sourceIds.length>32||new Set(P.sourceIds).size!==P.sourceIds.length||P.sourceIds.some(id=>!/^[a-f0-9]{32}$/.test(id)))throw Error('refused');
    for(const id of P.sourceIds)sourceFiles.push(await read(id));
    if(JSON.stringify({records,files,sourceFiles}).length>2097152)throw Error('refused');
    return {ok:true,records,heads,files,sourceFiles};
  }catch(error){return {ok:false,stage,apiCode:error?.name==='ApiError'&&['device_revoked','rotation_pending','generation_mismatch','unknown_file','grant_changed'].includes(error.code)?error.code:null,apiStatus:Number.isInteger(error?.status)&&error.status>=0&&error.status<=599?error.status:null};}
}
const checkpointReasons=new Set(['draft_inventory_binding','pending_engine_not_stopped','rotation_operation_binding','frozen_inventory_incomplete','prepared_receipt_binding','frozen_source_histories_changed','prepared_inventory_changed','pending_phase_refused','catalog_receipt_binding','destination_inventory_binding','destination_inventory_incomplete','destination_history_incomplete','file_inventory_bound','file_history_bound','file_history_identity','file_inventory_duplicate','backup_generation_binding','plan_source_inventory','plan_unknown_file','plan_unknown_version','plan_nonmetadata_operation']);
export function knownNotesFailure(error,stage){
  return {result:'FAIL',stage,firstFailure:error instanceof OracleFailure?error.code:'owned_known_notes_inventory_refused',checkpointReason:error instanceof CheckpointFailure&&checkpointReasons.has(error.reason)?error.reason:null};
}
export async function main(argv=process.argv.slice(2)){
const [run,label,...args]=argv,options={};
let state,client,stage='arguments',nativeDiagnostic=null;
try{
  for(let i=0;i<args.length;i+=2){const key=args[i]?.slice(2);check(args[i]?.startsWith('--')&&['source','backup','rotation-proof'].includes(key)&&!options[key]&&args[i+1],'arguments');options[key]=args[i+1];}
  check(/^[a-z][a-z0-9-]{0,32}$/.test(label)&&options.source&&['old','new'].includes(options.backup),'arguments');
  check(options['rotation-proof']===undefined||options['rotation-proof']==='commit-after'&&options.backup==='new','rotation_proof_mode');
  stage='owned_source';state=boundManifest(resolve(run),options.source);
  const output=join(state.secrets,`known-notes-${label}.json`);
  check(!existsSync(output),'fresh_inventory_label');
  stage='candidate_crypto';const api=candidateCrypto(options.source,state.source_head,state.artifacts['plugin/main.js'],!!options['rotation-proof']);
  stage='current_backup';const root=await api.backup.parseRecoveryBackup(privateRead(join(state.secrets,`phone-${options.backup}-recovery-backup.txt`)));
  const keys=await api.dm.domainMapKeys(root);
  let binding=null;
  if(options['rotation-proof']){
    stage='checkpoint_binding';
    const draftPath=join(state.secrets,'checkpoint-rotation-draft.json'),commitPath=join(state.secrets,'checkpoint-commit-after.json');
    binding=rotationProofBinding(checkpointBytes(draftPath),checkpointBytes(commitPath),JSON.parse(privateRead(join(state.run,'evidence/native-checkpoint-rotation-draft.json'))),JSON.parse(privateRead(join(state.run,'evidence/native-checkpoint-commit-after.json'))),{sourceHead:state.source_head,generation:keys.fileId,decoderHash:api.decoderHash});
  }
  stage='connect_native';client=await connect(state,'A');
  stage='account_inventory';
  const captured=await client.evaluate(`return await (${readKnownInventory.toString()})(app,P);`,{generation:keys.fileId,sourceIds:binding?.draft.records.map(r=>r.fileId)??[]});
  if(!captured.ok){nativeDiagnostic=captured;throw Error('native inventory refused');}
  stage='current_map_authentication';
  const mapRecord=captured.records.find(r=>r.file_id===keys.fileId);
  check(mapRecord&&mapRecord.domain_id===keys.domainId&&mapRecord.sids.length===0&&mapRecord.bytes===0&&!mapRecord.deleted,'authenticated_map_record');
  check(await api.c.versionId(mapRecord.file_id,mapRecord.parents,api.wire.readManifestSeal2(mapRecord),mapRecord.sids)===mapRecord.version_id,'map_version_hash');
  const mapFile={file_id:mapRecord.file_id,domain_id:mapRecord.domain_id,heads:[mapRecord.version_id],versions:[mapRecord]};
  const map=await api.dm.loadDomainMap({getFile:async id=>{check(id===keys.fileId,'map_id');return mapFile;}},keys);
  const domainId=api.dm.soleDomain(map);check(domainId,'sole_current_domain');
  stage='current_domain_keys';const domain=await api.c.deriveDomainKey(root,domainId),manifestKey=await api.c.deriveManifestKey(domain,domainId);
  let partition={records:captured.records};
  if(binding){
    stage='old_backup';const oldRoot=await api.backup.parseRecoveryBackup(privateRead(join(state.secrets,'phone-old-recovery-backup.txt')));
    stage='destination_plan';const derived=await deriveCheckpointDestinations(api,binding.draft,captured.sourceFiles,inventoryHeads(binding.draft.records),oldRoot,root);
    stage='current_partition';partition=partitionRotationRecords(binding,captured,keys,domainId,derived);
  }
  const files=[],ciphertextHashes=[digest(api.c.unbase64(mapRecord.manifest_ct))];
  for(const record of partition.records){
    stage='current_note_manifest';
    if(record.file_id===keys.fileId)continue;
    check(record.domain_id===domainId,'current_domain_inventory');
    const ct=api.wire.readManifestSeal2(record);
    check(await api.c.versionId(record.file_id,record.parents,ct,record.sids)===record.version_id,'manifest_version_hash');
    const entry=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(await api.seal.openRecord(manifestKey,1,recordContext(record),ct)));
    check(entry.domain===domainId&&typeof entry.path==='string'&&api.dm.domainFor(map,entry.path)===domainId,'manifest_domain_binding');
    ciphertextHashes.push(digest(ct));
    if(entry.deleted){check(record.deleted===true,'tombstone_binding');continue;}
    if(entry.v===2&&entry.kind==='directory'){check(record.bytes===0&&record.sids.length===0,'folder_binding');continue;}
    check(entry.v===1&&entry.deleted===false&&!record.deleted&&/^[A-Za-z0-9 -]+(?:\/[A-Za-z0-9 -]+)*\.md$/.test(entry.path)&&entry.size>0&&entry.size<=16384&&record.bytes===entry.size&&Array.isArray(entry.chunks)&&entry.chunks.length===1&&record.sids.length===1,'bounded_synthetic_note');
    const chunk=entry.chunks[0];check(chunk.sid===record.sids[0]&&chunk.len===entry.size&&/^[a-f0-9]{64}$/.test(chunk.cid),'chunk_binding');
    stage='current_note_chunk';const raw=await client.evaluate(`const p=app.plugins.plugins['obsync-private-sync'];if(p.state.custody2()?.generation!==P.generation||p.currentStatus().kind!=='idle')throw Error('inventory generation changed');const bytes=await p.transport.getChunk(P.sid,undefined,{interactive:true});if(bytes.length!==P.expectedBytes)throw Error('known chunk length differs');return Array.from(bytes);`,{generation:keys.fileId,sid:chunk.sid,expectedBytes:entry.size+16});
    const ciphertext=Uint8Array.from(raw);check(digest(ciphertext)===chunk.sid,'chunk_hash');
    stage='current_note_plaintext';const plain=await api.seal.decryptChunk2(domain,{generation:keys.fileId,domainId},api.c.unhex(chunk.cid),ciphertext);
    check(plain.length===entry.size&&digest(plain)===entry.sha256,'plaintext_hash');
    stage='retained_disk';const disk=join(state.devices.A.vault,entry.path);owned(disk,false,false);check(Buffer.from(plain).equals(readFileSync(disk)),'retained_disk_bytes');
    check(!files.some(f=>f.path===entry.path),'unique_note_path');
    files.push({path:entry.path,sha256:digest(plain),fileIdHash:digest(record.file_id)});ciphertextHashes.push(digest(ciphertext));
  }
  check(files.length>0&&files.length<=32,'nonempty_note_inventory');
  stage='head_stability';await client.evaluate(`const p=app.plugins.plugins['obsync-private-sync'];const page=await p.transport.listFiles(null,{interactive:true});const heads=page.files.map(f=>[f.file_id,[...f.heads].sort()]).sort((a,b)=>a[0].localeCompare(b[0]));if(page.next!==null||JSON.stringify(heads)!==JSON.stringify(P.heads)||p.state.custody2()?.generation!==P.generation||p.currentStatus().kind!=='idle')throw Error('inventory changed during verification');for(const expected of P.sourceRecords){const f=await p.transport.getFile(expected.fileId,{interactive:true});if(f.file_id!==expected.fileId||f.versions.length>128||JSON.stringify(f).length>1048576||JSON.stringify([...f.heads].sort())!==JSON.stringify(expected.heads)||JSON.stringify(f.versions.map(v=>v.version_id).sort())!==JSON.stringify(expected.versions))throw Error('pinned source inventory changed during verification');}return true;`,{generation:keys.fileId,heads:captured.heads,sourceRecords:binding?.draft.records??[]});
  stage='retained_disk_after';for(const file of files){const disk=join(state.devices.A.vault,file.path);owned(disk,false,false);check(digest(readFileSync(disk))===file.sha256,'retained_disk_changed');}
  const proof={schema:1,sourceHead:state.source_head,generationHash:digest(keys.fileId),observedAt:Date.now(),completeServerInventory:true,rotationCheckpointSha256:partition.rotationCheckpointSha256,pinnedPreviousFileCount:partition.pinnedPreviousFileCount,files:files.sort((a,b)=>a.path.localeCompare(b.path)),origin:'authenticated-current-map-and-heads-detached-open',bundleSha256:state.artifacts['plugin/main.js'],decoderHash:api.decoderHash,serverHeadsHash:digest(JSON.stringify(captured.heads)),ciphertextHashes};
  stage='save_proof';privateSave(output,JSON.stringify(proof));
  const receipt={result:'PASS',sourceHead:state.source_head,label,readOnly:true,noteCount:files.length,currentMapAuthenticated:true,completeBoundedServerInventory:true,allCurrentNotesOpenAndMatchRetainedDisk:true,generationHash:proof.generationHash,proofSha256:digest(readFileSync(output)),decoderHash:api.decoderHash,physicalPhone:'NOT_RUN',rotationCheckpointSha256:partition.rotationCheckpointSha256,pinnedPreviousFileCount:partition.pinnedPreviousFileCount};
  stage='write_receipt';writeFileSync(join(state.run,'evidence',`known-notes-${label}.json`),JSON.stringify(receipt,null,2)+'\n',{mode:0o600,flag:'wx'});console.log(JSON.stringify(receipt));
}catch(error){const receipt={...knownNotesFailure(error,stage),sourceHead:state?.source_head??null,nativeDiagnostic};if(state&&/^[a-z][a-z0-9-]{0,32}$/.test(label))writeFileSync(join(state.run,'evidence',`known-notes-${label}-failure.json`),JSON.stringify(receipt,null,2)+'\n',{mode:0o600,flag:'wx'});console.log(JSON.stringify(receipt));process.exitCode=1;}finally{client?.close();}

}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))await main();
