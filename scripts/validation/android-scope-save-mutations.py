#!/usr/bin/env python3
"""Finite actual Android readiness and scope Save controls; no native apps/devices; timeout never a kill."""
import argparse,json,subprocess,tempfile,shutil
from pathlib import Path
p=argparse.ArgumentParser();p.add_argument('--node',required=True);args=p.parse_args();root=Path(__file__).resolve().parent
mutants=[
 ('native_readiness_late_refused','ready:after.ready&&now()<=end','ready:after.ready'),
 ('native_readiness_includes_initial_read','const started=now(),before=read(),end=started+budget;let after=before,polls=1;','const before=read(),end=now()+budget;let after=before,polls=1;'),
 ('settling_required',',P.budget,200);',',P.budget,0);'),
 ('readiness_required',"if(!pointerReadiness.ready)throw Error('ordinary scope Save pointer readiness deadline');",'void 0;'),
 ('read_without_rescroll','(target,false);};return await','(target,true);};return await'),
 ('readonly_final_check','deadline:scopeSaveDeadline,scroll:false','deadline:scopeSaveDeadline,scroll:true'),
 ('motion_resets_stability','stableSince=now();}current=next;','stableSince??=now();}current=next;'),
 ('one_actual_click',"      await trustedPointerClick({selector:'.modal.mod-settings .setting-item button',expectedText:'Save',settingRow:'Save on this device',point,deadline:scopeSaveDeadline,scroll:false});",'      // omitted click'),
 ('expected_setting_row',"&&(!P.settingRow||e.closest('.setting-item')?.querySelector('.setting-item-name')?.textContent.trim()===P.settingRow)",''),
 ('witness_required',"if(!pointerWitnessMatches(pointerWitness))throw Error('ordinary trusted click not delivered');",'void 0;'),
 ('moved_target_refused',"if(Math.abs(point.x-P.x)>1||Math.abs(point.y-P.y)>1)throw Error('ordinary control moved before trusted click');",'void 0;'),
 ('exact_policy_required','after.policyMatches===true','true'),
 ('same_absolute_deadline','},undefined,undefined,30000,scopeSaveDeadline);','},undefined,undefined,30000);'),
 ('late_policy_refused','ready=now()<=end&&after.changingScope===false','ready=after.changingScope===false'),
 ('required_saved_result',"      if(!scopeSaveReadiness.ready)throw Error('saved selected scope deadline');",'      // omitted refusal'),
]
with tempfile.TemporaryDirectory(prefix='obsync-scope-save-controls-') as tmp:
 work=Path(tmp);(work/'mobile').mkdir()
 for name in ('android-journey.mjs','tcp-target.mjs','mobile/cdp.mjs','mobile/scope-save-witness.test.mjs','mobile/native-readiness-deadline.test.mjs'):shutil.copyfile(root/name,work/name)
 target=work/'android-journey.mjs';source=target.read_text()
 def check():return subprocess.run([args.node,'--test',str(work/'mobile/scope-save-witness.test.mjs'),str(work/'mobile/native-readiness-deadline.test.mjs')],stdout=subprocess.PIPE,stderr=subprocess.STDOUT,timeout=10)
 if check().returncode:raise RuntimeError('scope Save baseline failed')
 killed=[]
 for name,old,new in mutants:
  if source.count(old)!=1:raise RuntimeError('ambiguous mutant '+name)
  target.write_text(source.replace(old,new,1));r=check()
  if r.returncode==0:raise RuntimeError('survived '+name)
  if b'SyntaxError' in r.stdout:raise RuntimeError('invalid '+name)
  killed.append(name)
 print(json.dumps({'result':'PASS','kind':'OFFLINE_SCOPE_SAVE_WITNESS_MUTATION_CONTROLS','nativeAcceptance':False,'count':len(killed),'killed':killed}))
