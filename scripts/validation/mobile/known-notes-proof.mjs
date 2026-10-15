// Authenticated, bounded, read-only retained-peer inventory. Detached candidate
// crypto opens server bytes; no native engine/store/transport mutation or keys
// returned from the renderer. Run BEFORE generating the next invitation.
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {boundManifest,owned,privateRead,privateSave,digest} from './desktop-guard.mjs';
import {connect} from './cdp.mjs';
import {candidateCrypto,recordContext,OracleFailure} from './ciphertext-oracle.mjs';

const [run,label,...args]=process.argv.slice(2),options={};
let state,client;
const check=(value,code)=>{if(!value)throw new OracleFailure(code);};
try{
  for(let i=0;i<args.length;i+=2){const key=args[i]?.slice(2);check(args[i]?.startsWith('--')&&['source','backup'].includes(key)&&!options[key]&&args[i+1],'arguments');options[key]=args[i+1];}
  check(/^[a-z][a-z0-9-]{0,32}$/.test(label)&&options.source&&['old','new'].includes(options.backup),'arguments');
  state=boundManifest(resolve(run),options.source);
  const output=join(state.secrets,`known-notes-${label}.json`);
  check(!existsSync(output),'fresh_inventory_label');
  const api=candidateCrypto(options.source,state.source_head,state.artifacts['plugin/main.js']);
  const root=await api.backup.parseRecoveryBackup(privateRead(join(state.secrets,`phone-${options.backup}-recovery-backup.txt`)));
  const keys=await api.dm.domainMapKeys(root);
  client=await connect(state,'A');
  const captured=await client.evaluate(`
    const p=app.plugins.plugins['obsync-private-sync'],pin=p?.state?.custody2(),ctx=p?.engine?.contextValue;
    if(!p?.state?.paired||p.state.data.serverUrl!==P.url||pin?.suite!==2||pin.phase!=='active'||pin.rotation||!ctx||ctx.generation!==P.generation||pin.generation!==P.generation||p.currentStatus().kind!=='idle')throw Error('active retained generation required');
    const page=await p.transport.listFiles(null,{interactive:true});
    if(page.next!==null||page.files.length<1||page.files.length>32)throw Error('complete bounded account inventory required');
    const heads=page.files.map(f=>[f.file_id,[...f.heads].sort()]).sort((a,b)=>a[0].localeCompare(b[0])),records=[];
    for(const item of page.files){
      if(!/^[a-f0-9]{32}$/.test(item.file_id)||item.heads.length!==1)throw Error('unambiguous current heads required');
      const file=await p.transport.getFile(item.file_id,{interactive:true});
      if(file.file_id!==item.file_id||JSON.stringify([...file.heads].sort())!==JSON.stringify([...item.heads].sort())||file.versions.length>128)throw Error('file inventory changed');
      const head=file.versions.find(v=>v.version_id===item.heads[0]);
      if(!head||head.seal_suite!==2||head.sids.length>1||head.bytes>16384)throw Error('bounded current record required');
      records.push({...head,file_id:file.file_id,domain_id:file.domain_id,generation:P.generation});
    }
    if(JSON.stringify(records).length>2097152)throw Error('record capture budget');
    return {records,heads};`,{generation:keys.fileId});
  const mapRecord=captured.records.find(r=>r.file_id===keys.fileId);
  check(mapRecord&&mapRecord.domain_id===keys.domainId&&mapRecord.sids.length===0&&mapRecord.bytes===0&&!mapRecord.deleted,'authenticated_map_record');
  check(await api.c.versionId(mapRecord.file_id,mapRecord.parents,api.wire.readManifestSeal2(mapRecord),mapRecord.sids)===mapRecord.version_id,'map_version_hash');
  const mapFile={file_id:mapRecord.file_id,domain_id:mapRecord.domain_id,heads:[mapRecord.version_id],versions:[mapRecord]};
  const map=await api.dm.loadDomainMap({getFile:async id=>{check(id===keys.fileId,'map_id');return mapFile;}},keys);
  const domainId=api.dm.soleDomain(map);check(domainId,'sole_current_domain');
  const domain=await api.c.deriveDomainKey(root,domainId),manifestKey=await api.c.deriveManifestKey(domain,domainId);
  const files=[],ciphertextHashes=[digest(api.c.unbase64(mapRecord.manifest_ct))];
  for(const record of captured.records){
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
    const raw=await client.evaluate(`const p=app.plugins.plugins['obsync-private-sync'];if(p.state.custody2()?.generation!==P.generation||p.currentStatus().kind!=='idle')throw Error('inventory generation changed');const bytes=await p.transport.getChunk(P.sid,undefined,{interactive:true});if(bytes.length!==P.expectedBytes)throw Error('known chunk length differs');return Array.from(bytes);`,{generation:keys.fileId,sid:chunk.sid,expectedBytes:entry.size+16});
    const ciphertext=Uint8Array.from(raw);check(digest(ciphertext)===chunk.sid,'chunk_hash');
    const plain=await api.seal.decryptChunk2(domain,{generation:keys.fileId,domainId},api.c.unhex(chunk.cid),ciphertext);
    check(plain.length===entry.size&&digest(plain)===entry.sha256,'plaintext_hash');
    const disk=join(state.devices.A.vault,entry.path);owned(disk,false,false);check(Buffer.from(plain).equals(readFileSync(disk)),'retained_disk_bytes');
    check(!files.some(f=>f.path===entry.path),'unique_note_path');
    files.push({path:entry.path,sha256:digest(plain),fileIdHash:digest(record.file_id)});ciphertextHashes.push(digest(ciphertext));
  }
  check(files.length>0&&files.length<=32,'nonempty_note_inventory');
  await client.evaluate(`const p=app.plugins.plugins['obsync-private-sync'];const page=await p.transport.listFiles(null,{interactive:true});const heads=page.files.map(f=>[f.file_id,[...f.heads].sort()]).sort((a,b)=>a[0].localeCompare(b[0]));if(page.next!==null||JSON.stringify(heads)!==JSON.stringify(P.heads)||p.state.custody2()?.generation!==P.generation||p.currentStatus().kind!=='idle')throw Error('inventory changed during verification');return true;`,{generation:keys.fileId,heads:captured.heads});
  for(const file of files){const disk=join(state.devices.A.vault,file.path);owned(disk,false,false);check(digest(readFileSync(disk))===file.sha256,'retained_disk_changed');}
  const proof={schema:1,sourceHead:state.source_head,generationHash:digest(keys.fileId),observedAt:Date.now(),completeServerInventory:true,files:files.sort((a,b)=>a.path.localeCompare(b.path)),origin:'authenticated-current-map-and-heads-detached-open',bundleSha256:state.artifacts['plugin/main.js'],decoderHash:api.decoderHash,serverHeadsHash:digest(JSON.stringify(captured.heads)),ciphertextHashes};
  privateSave(output,JSON.stringify(proof));
  const receipt={result:'PASS',sourceHead:state.source_head,label,readOnly:true,noteCount:files.length,currentMapAuthenticated:true,completeBoundedServerInventory:true,allCurrentNotesOpenAndMatchRetainedDisk:true,generationHash:proof.generationHash,proofSha256:digest(readFileSync(output)),decoderHash:api.decoderHash,physicalPhone:'NOT_RUN'};
  writeFileSync(join(state.run,'evidence',`known-notes-${label}.json`),JSON.stringify(receipt,null,2)+'\n',{mode:0o600,flag:'wx'});console.log(JSON.stringify(receipt));
}catch(error){console.log(JSON.stringify({result:'FAIL',firstFailure:error instanceof OracleFailure?error.code:'owned_known_notes_inventory_refused'}));process.exitCode=1;}finally{client?.close();}
