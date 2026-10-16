#!/usr/bin/env python3
"""Finite folder diagnostic controls; no device/native app, timeout never a kill."""
import argparse
import json
from pathlib import Path
import shutil
import subprocess
import tempfile

p=argparse.ArgumentParser();p.add_argument('--node',required=True);args=p.parse_args()
root=Path(__file__).resolve().parent
mutations=[
 ('original10s','const started=now(),end=started+10000;let first=null,last=null,polls=0;','const started=now(),end=started+20000;let first=null,last=null,polls=0;'),
 ('folder_presence','if(f&&Array.isArray(f.children)){','if(Array.isArray(f?.children)||!f){'),
 ('folder_children_array','if(f&&Array.isArray(f.children)){','if(f){'),
 ('identity_predicate',"if(rows&&rows.every(r=>/^[a-f0-9]{32}$/.test(r.id??'')))",'if(rows)'),
 ('descendant_bound','if(files.length>32){first??=facts;','if(files.length>64){first??=facts;'),
 ('first_observation','    first??=facts;last=facts;polls++;','    first=facts;last=facts;polls++;'),
 ('original100ms_poll','    await pause(100);\n  }\n  return result(false);','    await pause(200);\n  }\n  return result(false);'),
 ('host_deadline_refusal',"      if(!observed.ready)throw Error('native folder index deadline');",'      // omitted refusal'),
 ('host_bound_refusal',"      if(observed.boundExceeded)throw Error('bounded synthetic folder required');",'      // omitted bound refusal'),
 ('no_rows_in_diagnostics','const {rows:files,...facts}=observed;folderIndexReadiness=facts;','const {rows:files}=observed;folderIndexReadiness=observed;'),
 ('pass_receipt_facts','syncClaim:false,folderIndexReadiness});','syncClaim:false});'),
 ('fail_receipt_facts','replacementReadiness,installReadbacks,folderIndexReadiness,external:','replacementReadiness,installReadbacks,external:'),
]
with tempfile.TemporaryDirectory(prefix='obsync-folder-observation-') as tmp:
 work=Path(tmp);(work/'mobile').mkdir()
 for name in ('android-journey.mjs','mobile/cdp.mjs','mobile/folder-index-observation.test.mjs'):shutil.copyfile(root/name,work/name)
 target=work/'android-journey.mjs';original=target.read_text()
 def check():return subprocess.run([args.node,'--test',str(work/'mobile/folder-index-observation.test.mjs')],stdout=subprocess.PIPE,stderr=subprocess.STDOUT,timeout=10)
 base=check()
 if base.returncode:raise RuntimeError('folder controls baseline failed')
 killed=[]
 for name,old,new in mutations:
  if original.count(old)!=1:raise RuntimeError('ambiguous mutation '+name)
  target.write_text(original.replace(old,new,1));result=check()
  if result.returncode==0:raise RuntimeError('survived mutation '+name)
  if b'SyntaxError' in result.stdout:raise RuntimeError('invalid mutation '+name)
  killed.append(name)
 print(json.dumps({'result':'PASS','kind':'OFFLINE_FOLDER_OBSERVATION_MUTATION_CONTROLS','nativeAcceptance':False,'count':len(killed),'killed':killed}))
