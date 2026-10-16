#!/usr/bin/env python3
"""Finite note-read deadline/oracle mutations; no Android or native app calls."""
import argparse
import json
from pathlib import Path
import shutil
import subprocess
import tempfile

parser=argparse.ArgumentParser()
parser.add_argument('--node',required=True)
a=parser.parse_args()
root=Path(__file__).resolve().parent
mutations=[
 ('required_identity', '(!expectIdentity||observed.fileIdValid)', 'true'),
 ('native_note_index', 'observed.nativeNotePresent&&', 'true&&'),
 ('expected_pairing_state', 'observed.stateValid!==true', 'false'),
 ('malformed_present_identity', 'observed.identityPresent&&observed.fileIdValid!==true', 'false'),
 ('persisted_bytes_gate', 'observed.exactBytesMatched&&', 'true&&'),
 ('final_independent_bytes', "if(!persisted())throw Error('independent Android persisted bytes differ');", 'persisted();'),
 ('final_editor_bytes', "if(view.editor?.getValue()!==P.text)throw Error('native editor bytes differ');const final=check();", 'const final=check();'),
 ('final_identity_recheck', 'const final=check();return {editorMatches:true,fileIdPresent:final.fileIdValid};', 'const final={fileIdValid:true};return {editorMatches:true,fileIdPresent:final.fileIdValid};'),
 ('late_success', "if(Date.now()>end)throw Error('native note readiness deadline');", 'void 0;'),
 ('single_existing_deadline', 'end=Date.now()+15000,expectIdentity=', 'end=Date.now()+30000,expectIdentity='),
]
with tempfile.TemporaryDirectory(prefix='obsync-note-read-mutations-') as tmp:
 work=Path(tmp)/'scripts/validation';(work/'mobile').mkdir(parents=True)
 for name in ('android-journey.mjs','tcp-target.mjs','android-journey.test.mjs','mobile/cdp.mjs'):shutil.copyfile(root/name,work/name)
 history=Path(tmp)/'plugin/src/ui/history.ts';history.parent.mkdir(parents=True)
 shutil.copyfile(root.parent.parent/'plugin/src/ui/history.ts',history)
 target=work/'android-journey.mjs';baseline=target.read_text()
 def check():
  return subprocess.run([a.node,'--test',str(work/'android-journey.test.mjs')],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=30).returncode
 if check()!=0:raise SystemExit('note-read controls baseline must pass')
 killed=[]
 for name,old,new in mutations:
  if baseline.count(old)!=1:raise SystemExit('mutation target mismatch: '+name)
  target.write_text(baseline.replace(old,new))
  if check()==0:raise SystemExit('note-read mutation survived: '+name)
  killed.append(name);target.write_text(baseline)
 print(json.dumps({'result':'PASS','kind':'OFFLINE_NOTE_READ_MUTATION_CONTROLS','nativeAcceptance':False,'count':len(killed),'killed':killed}))
