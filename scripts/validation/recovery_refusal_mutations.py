#!/usr/bin/env python3
"""Kill finite recovery-refusal oracle mutations using actual setup renderer tests."""
import os
from pathlib import Path
import subprocess
import tempfile

ROOT=Path(__file__).resolve().parent
SOURCE=ROOT/'mobile/recovery.mjs'
GUARD=ROOT/'mobile/recovery-guard.mjs'
TEST=ROOT/'mobile/recovery-refusal.test.mjs'
MUTATIONS=[
 ('old_reason','source','negative?recoveryRefusal(action):null',"negative?{...recoveryRefusal(action),...(action==='setup-refuse-old'?{reason:'bad_recovery_proof'}:{})}:null"),
 ('unrelated_reason','source','negative?recoveryRefusal(action):null',"negative?{...recoveryRefusal(action),...(action==='setup-refuse-wrong'?{reason:'bad_recovery_proof'}:{})}:null"),
 ('missing_exact_refusal','source',"if((c.consoleSummary.reasons[refusal.reason]??0)<=baseline)throw Error('expected authenticated refusal absent');",''),
 ('custody_write_ignored','source', [('!unchanged||',''),('!finalUnchanged||','')],None),
 ('persisted_write_ignored','source', [('!diskUnchanged||',''),('||!finalDiskUnchanged','')],None),
 ('disk_content_ignored','source',"if(notes.some(note=>existsSync(join(state.devices[slot].vault,note.path))))throw Error('unexpected recovered disk content');",''),
 ('paired_ignored','guard',[('value.paired===false &&',''),('unpaired:value.paired===false','unpaired:true')],None),
 ('credential_id_ignored','guard',[('value.deviceIdAbsent===true &&',''),('deviceIdAbsent:value.deviceIdAbsent===true','deviceIdAbsent:true')],None),
 ('credential_secret_ignored','guard',[('value.deviceSecretAbsent===true &&',''),('deviceSecretAbsent:value.deviceSecretAbsent===true','deviceSecretAbsent:true')],None),
 ('active_phase_ignored','guard',[("value.phase==='enrollment' &&",''),("enrollmentPhase:value.phase==='enrollment'",'enrollmentPhase:true')],None),
 ('engine_ignored','guard',[('value.engineStopped===true &&',''),('engineStopped:value.engineStopped===true','engineStopped:true')],None),
 ('content_index_ignored','guard',[('value.contentAbsent===true;','true;'),('contentAbsent:value.contentAbsent===true','contentAbsent:true')],None),
 ('visible_notice_ignored','guard',[("return owned.length===1&&",'return true||owned.length===1&&')],None),
 ('enrolling_ignored','guard',[('return value.enrolling===false && value.paired===false','return value.paired===false'),('notEnrolling:value.enrolling===false','notEnrolling:true')],None),
 ('recent_title_ignored','guard',"m.querySelector('.modal-title')?.textContent.trim()==='Recent sync activity'",'true'),
 ('positive_paired_ignored','guard','return value.paired===true &&','return '),
 ('positive_phase_ignored','guard',"value.phase==='active' &&",''),
 ('positive_enrolling_ignored','guard','value.enrolling===false && value.phase', 'value.phase'),
 ('hardcode_export_bytes','guard',"writeFileSync(file,actual,{mode:0o600,flag:previous?'w':'wx'});","writeFileSync(file,Buffer.from('expected bytes'),{mode:0o600,flag:previous?'w':'wx'});"),
 ('export_before_mapping','guard',"writeFileSync(join(folder,'expectations.json'),bytes,{mode:0o600,flag:'wx'});",''),
 ('omit_actual_export','guard',"writeFileSync(file,actual,{mode:0o600,flag:previous?'w':'wx'});",''),
 ('false_export_hash','guard','actualSha256=hash(actual)','actualSha256=manifest.notes[index].sha256'),
 ('partial_export_pass','guard',"success===true&&exports.length===manifest.notes.length&&exports.every(e=>e.exactHashMatched)",'success===true'),
 ('omit_failed_export_result','guard',"writeFileSync(join(folder,'result.json'),JSON.stringify(result,null,2)+'\\n',{mode:0o600,flag:'wx'});",''),
]

def run():
    source=SOURCE.read_text();guard=GUARD.read_text()
    with tempfile.TemporaryDirectory(prefix='obsync-refusal-mutants-') as tmp:
        directory=Path(tmp)
        for name,kind,before,after in MUTATIONS:
            original=source if kind=='source' else guard
            edits=[(before,after)] if isinstance(before,str) else before
            for old,new in edits:
                if original.count(old)!=1:raise RuntimeError('mutation anchor ambiguous: '+name+' '+old)
                original=original.replace(old,new)
            mutant=directory/(name+'.mjs');mutant.write_text(original)
            env=dict(os.environ)
            env['OBSYNC_RECOVERY_SOURCE' if kind=='source' else 'OBSYNC_RECOVERY_GUARD_MODULE']=str(mutant) if kind=='source' else mutant.as_uri()
            result=subprocess.run(['node','--test','--test-reporter=tap',str(TEST)],env=env,capture_output=True,text=True,timeout=10)
            if result.returncode==0:raise RuntimeError('SURVIVED: '+name)
            if "code: 'ERR_ASSERTION'" not in result.stdout or "failureType: 'testCodeFailure'" not in result.stdout or 'SyntaxError' in result.stdout or 'ERR_MODULE_NOT_FOUND' in result.stdout:raise RuntimeError('not an assertion failure: '+name)
            print('KILLED '+name)
    print('PASS: '+str(len(MUTATIONS))+' recovery-refusal mutants killed')

if __name__=='__main__':run()
