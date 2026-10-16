#!/usr/bin/env python3
"""Finite offline replacement-consent and authenticated-inventory mutations."""
import argparse,json,os,shutil,subprocess,tempfile
from pathlib import Path
p=argparse.ArgumentParser();p.add_argument('--node',required=True);p.add_argument('--source',required=True);a=p.parse_args()
root=Path(__file__).resolve().parent
mutations=[
 ('checkpoint_bytes','known-notes-proof.mjs','receipt.checkpointSha256===digest(text)','true'),
 ('checkpoint_source','known-notes-proof.mjs','receipt.sourceHead===context.sourceHead&&proof?.sourceHead===context.sourceHead','true'),
 ('checkpoint_result','known-notes-proof.mjs','receipt.result===result','true'),
 ('checkpoint_generation','known-notes-proof.mjs','commit.generation===context.generation','true'),
 ('checkpoint_decoder','known-notes-proof.mjs','commit.decoderHash===context.decoderHash','true'),
 ('frozen_inventory','known-notes-proof.mjs','assertFrozenInventory(draft,commit,commit.rotationStatus,inventoryHeads(draft.records));','void 0;'),
 ('destination_inventory','known-notes-proof.mjs','assertDestinations(draft,commit,commit.destinations);','void 0;'),
 ('destination_derivation','known-notes-proof.mjs',"check(JSON.stringify(derived)===JSON.stringify(commit.destinations),'rotation_destination_plan');",'void 0;'),
 ('derive_metadata_only_wiring','known-notes-proof.mjs','const derived=await deriveCheckpointDestinations(api,binding.draft,captured.files,inventoryHeads(binding.draft.records),oldRoot,root);','const derived=binding.commit.destinations;'),
 ('closed_full_head_equality','known-notes-proof.mjs','JSON.stringify(heads)!==JSON.stringify(P.heads)','false'),
 ('current_union','known-notes-proof.mjs',"check([...oldIds,...derived.map(row=>row[1])].every(id=>ids.has(id)),'rotation_current_union_incomplete');",'void 0;'),
 ('old_head_and_version_set','known-notes-proof.mjs',"check(JSON.stringify(records.filter(r=>oldIds.has(r.fileId)))===JSON.stringify(draft.records),'rotation_old_histories_changed');",'void 0;'),
 ('head_record_completeness','known-notes-proof.mjs',"check(captured.records.length===records.length&&new Set(captured.records.map(r=>r.file_id)).size===records.length&&captured.records.every(r=>ids.has(r.file_id)),'rotation_head_records_incomplete');",'void 0;'),
 ('foreign_not_excludable','known-notes-proof.mjs',"check(current.every(r=>r.file_id===keys.fileId?r.domain_id===keys.domainId:r.domain_id===domainId),'rotation_unpinned_or_foreign_record');",'void 0;'),
 ('current_manifest_domain','known-notes-proof.mjs',"check(record.domain_id===domainId,'current_domain_inventory');",'void 0;'),
 ('current_version_hash','known-notes-proof.mjs',"check(await api.c.versionId(record.file_id,record.parents,ct,record.sids)===record.version_id,'manifest_version_hash');",'void 0;'),
 ('current_chunk_hash','known-notes-proof.mjs',"check(digest(ciphertext)===chunk.sid,'chunk_hash');",'void 0;'),
 ('independent_current_disk','known-notes-proof.mjs',"check(Buffer.from(plain).equals(readFileSync(disk)),'retained_disk_bytes');",'void 0;'),
 ('old_pairing_must_wait','../android-journey.mjs','after.paired&&(!replacement||after.currentGenerationMatched)','after.paired'),
 ('unrelated_pairing_refused','../android-journey.mjs','replacement&&after.paired&&!after.currentGenerationMatched&&!after.oldGenerationStillHeld','false'),
 ('status_history_generation','../android-journey.mjs','!after.historyGenerationMatched','false'),
 ('status_current_generation','../android-journey.mjs','after.historyPresent&&(!after.historySuite2||!after.historyGenerationMatched)||!after.currentGenerationMatched&&!after.oldGenerationStillHeld','after.historyPresent&&(!after.historySuite2||!after.historyGenerationMatched)||false'),
 ('status_deadline','../android-journey.mjs','facts.ready=!facts.refused&&now()<=end&&after.paired&&after.suite2','facts.ready=!facts.refused&&after.paired&&after.suite2'),
]
with tempfile.TemporaryDirectory(prefix='obsync-rotation-consent-') as tmp:
 work=Path(tmp)/'scripts/validation/mobile';work.mkdir(parents=True)
 for name in ('known-notes-proof.mjs','rotation-consent.test.mjs','desktop-guard.mjs','cdp.mjs','ciphertext-oracle.mjs','native-checkpoint.mjs'):shutil.copyfile(root/name,work/name)
 for name in ('android-journey.mjs','mobile-full.py'):shutil.copyfile(root.parent/name,work.parent/name)
 baselines={name:(work/name).read_text() for name in {row[1] for row in mutations}}
 env=os.environ|{'OBSYNC_ORACLE_SOURCE':str(Path(a.source).resolve())}
 def check():return subprocess.run([a.node,'--test','--test-isolation=none',str(work/'rotation-consent.test.mjs')],env=env,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=10).returncode
 if check()!=0:raise SystemExit('replacement consent controls baseline must pass')
 killed=[]
 for name,path,old,new in mutations:
  before=baselines[path]
  if before.count(old)!=1:raise SystemExit('mutation target mismatch: '+name)
  (work/path).write_text(before.replace(old,new))
  if check()==0:raise SystemExit('replacement consent mutation survived: '+name)
  killed.append(name);(work/path).write_text(before)
 full=work.parent/'mobile-full.py';before=full.read_text()
 line="    phone('rotation-repair-local-consent', 'pair-consent', {'expectedGenerationHash': new_status['generationHash'], 'expectedOldGenerationHash': old_status['generationHash'], 'invitationFile': str(invitation),\n        'knownNotesProof': str(desktop / 'private/desktop/known-notes-rotation-repair.json')})\n"
 if before.count(line)!=1:raise SystemExit('replacement consent wiring target mismatch')
 full.write_text(before.replace(line,''))
 if check()==0:raise SystemExit('replacement consent wiring mutation survived')
 killed.append('ordinary_consent_wiring')
 print(json.dumps({'result':'PASS','kind':'OFFLINE_ROTATION_CONSENT_MUTATION_CONTROLS','nativeAcceptance':False,'count':len(killed),'killed':killed}))
