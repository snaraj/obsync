#!/usr/bin/env python3
"""Kill finite recovery-refusal oracle mutations using actual setup renderer tests."""
import os
from pathlib import Path
import subprocess
import tempfile

ROOT=Path(__file__).resolve().parent
SOURCE=ROOT/'mobile/recovery.mjs'
GUARD=ROOT/'mobile/recovery-guard.mjs'
TESTS=[ROOT/'mobile/recovery-refusal.test.mjs',ROOT/'mobile/recovery-guard.test.mjs']
MUTATIONS=[
 ('open_primary_refusal_required','source',"if(!trusted)throw Error('fresh owned vault/plugin not ready');",''),
 ('open_failure_redaction','source','errorClass:openErrorClass(error)','errorClass:error.message'),
 ('open_failure_evidence_required','source','negativeReadiness,openReadiness,detail:','negativeReadiness,detail:'),
 ('open_failure_exit_required','source','process.exitCode=1;','process.exitCode=0;'),
 ('open_dispatch_observation','source',"openReadiness.initialDispatch='COMPLETED'","openReadiness.initialDispatch='STARTED'"),
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


# Chooser prerequisite and opening-budget controls use the same source/module seams.
MUTATIONS += [
 ('chooser_first_page_unchecked','guard',"pages.filter(p=>p.url==='app://obsidian.md/starter.html')",'pages.slice(0,1)'),
 ('chooser_uninitialized_admitted','guard','return value.exactUrl&&value.documentReady&&value.starterInnerCount===1&&value.callableIpc;','return true;'),
 ('chooser_extra_renderer_fields','guard',"Object.keys(value).sort().join(',')!=='callableIpc,documentReady,exactUrl,starterInnerCount'||",''),
 ('chooser_atomic_guard_omitted','source',"if(!(${initializedRecoveryChooser.toString()})((${recoveryChooserFacts.toString()})()))return false;",''),
 ('chooser_deadline_refusal_omitted','source',"if(ms<=0)throw Error('fresh owned recovery open deadline');",''),
 ('chooser_timer_cancellation_omitted','source','clearTimeout(openDeadlineTimer);',''),
 ('chooser_watchdog_writer_loses_exit','source','finally{try{c?.close();}finally{process.exit(1);}}','finally{c?.close();}'),
 ('chooser_success_evidence_omitted','source',"record({result:'READY',freshDetachedVault:true,usesExistingApi:true,openReadiness});","record({result:'READY',freshDetachedVault:true,usesExistingApi:true});"),
 ('chooser_post_record_deadline_omitted','source',"openReadiness});remaining(); // Synchronous",'openReadiness}); // Synchronous'),
 ('chooser_elapsed_omitted','source','openReadiness.elapsedMs=45000-remaining();','remaining();'),
 ('chooser_dispatch_twice','source',"ipcRenderer.sendSync('vault-open',P.vault,false);return true;","ipcRenderer.sendSync('vault-open',P.vault,false);require('electron').ipcRenderer.sendSync('vault-open',P.vault,false);return true;"),
 ('chooser_http_failure_retried','source','await targets(state,slot)','await targets(state,slot).catch(()=>[])'),
 ('chooser_poll_budget_changed','source','await sleep(Math.min(200,remaining()));\n    }\n    // Exactly','await sleep(Math.min(500,remaining()));\n    }\n    // Exactly'),
 ('chooser_raw_target_id_export','source',"createHash('sha256').update(target.id).digest('hex')",'target.id'),
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
            result=subprocess.run(['node','--test','--test-reporter=tap',*map(str,TESTS)],env=env,capture_output=True,text=True,timeout=10)
            if result.returncode==0:raise RuntimeError('SURVIVED: '+name)
            if "code: 'ERR_ASSERTION'" not in result.stdout or "failureType: 'testCodeFailure'" not in result.stdout or 'SyntaxError' in result.stdout or 'ERR_MODULE_NOT_FOUND' in result.stdout:raise RuntimeError('not an assertion failure: '+name)
            print('KILLED '+name)
    print('PASS: '+str(len(MUTATIONS))+' recovery-refusal mutants killed')

if __name__=='__main__':run()
