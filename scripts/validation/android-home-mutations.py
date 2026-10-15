#!/usr/bin/env python3
"""Finite offline Home controls; temporary copies, no Android/SDK/device calls."""
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

root=Path(__file__).resolve().parent
mutations=[
 ('positive_resumed_activity', "counts['otherResumedCount']>0", 'True'),
 ('obsidian_must_not_be_resumed', "not counts['obsidianMentioned']", 'True'),
 ('exact_same_pid', 'matched=pid()==original', 'matched=bool(pid())'),
 ('initial_process_required', "if original is None:fail('home_application_absent')", 'if False:pass'),
 ('only_one_home_keypress', '    while True:\n        remaining()\n        matched=pid()==original', "    while True:\n        command(['shell','input','keyevent','KEYCODE_HOME'])\n        remaining()\n        matched=pid()==original"),
 ('late_success_refused', '        remaining()  # A late successful read cannot outrun the original budget.', '        pass  # MUTANT: late final read accepted'),
 ('session_deadline_clamp', "budget=max(0,min(30,state['expiresAtEpoch']-time.time()))", 'budget=30'),
]
with tempfile.TemporaryDirectory(prefix='obsync-home-mutations-') as tmp:
 work=Path(tmp)
 for name in ('android-session.py','android-apk.py','test_android_session.py'):shutil.copyfile(root/name,work/name)
 target=work/'android-session.py';baseline=target.read_text()
 def check():
  return subprocess.run([sys.executable,'-B','-m','unittest','test_android_session.HomeObservation'],cwd=work,
                         stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=30).returncode
 if check()!=0:raise SystemExit('Home controls baseline must pass')
 killed=[]
 for name,old,new in mutations:
  expected=2 if name=='exact_same_pid' else 1
  if baseline.count(old)!=expected:raise SystemExit('mutation target mismatch: '+name)
  target.write_text(baseline.replace(old,new))
  if check()==0:raise SystemExit('Home mutation survived: '+name)
  killed.append(name);target.write_text(baseline)
 print(json.dumps({'result':'PASS','kind':'OFFLINE_HOME_MUTATION_CONTROLS','nativeAcceptance':False,'count':len(killed),'killed':killed}))
