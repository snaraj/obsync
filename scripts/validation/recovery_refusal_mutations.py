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
 ('custody_write_ignored','source','if(!unchanged||!refused||!diskUnchanged)','if(!refused||!diskUnchanged)'),
 ('persisted_write_ignored','source','if(!unchanged||!refused||!diskUnchanged)','if(!unchanged||!refused)'),
 ('disk_content_ignored','source',"if(notes.some(note=>existsSync(join(state.devices[slot].vault,note.path))))throw Error('unexpected recovered disk content');",''),
 ('paired_ignored','guard','value.paired===false &&',''),
 ('credential_id_ignored','guard','value.deviceIdAbsent===true &&',''),
 ('credential_secret_ignored','guard','value.deviceSecretAbsent===true &&',''),
 ('active_phase_ignored','guard',"value.phase==='enrollment' &&",''),
 ('engine_ignored','guard','value.engineStopped===true &&',''),
 ('content_index_ignored','guard','value.contentAbsent===true','true'),
 ('visible_notice_ignored','guard','value.visibleRefusal===true &&',''),
 ('enrolling_ignored','guard','return value.enrolling===false && value.paired===false','return value.paired===false'),
]

def run():
    source=SOURCE.read_text();guard=GUARD.read_text()
    with tempfile.TemporaryDirectory(prefix='obsync-refusal-mutants-') as tmp:
        directory=Path(tmp)
        for name,kind,before,after in MUTATIONS:
            original=source if kind=='source' else guard
            if original.count(before)!=1:raise RuntimeError('mutation anchor ambiguous: '+name)
            mutant=directory/(name+'.mjs');mutant.write_text(original.replace(before,after))
            env=dict(os.environ)
            env['OBSYNC_RECOVERY_SOURCE' if kind=='source' else 'OBSYNC_RECOVERY_GUARD_MODULE']=str(mutant) if kind=='source' else mutant.as_uri()
            result=subprocess.run(['node','--test',str(TEST)],env=env,capture_output=True,text=True,timeout=10)
            if result.returncode==0:raise RuntimeError('SURVIVED: '+name)
            if '# fail ' not in result.stdout and '✖' not in result.stdout:raise RuntimeError('not an assertion failure: '+name)
            print('KILLED '+name)
    print('PASS: '+str(len(MUTATIONS))+' recovery-refusal mutants killed')

if __name__=='__main__':run()
