#!/usr/bin/env python3
"""Finite offline checkpoint mutations in a disposable helper-only copy."""
import argparse
import json
from pathlib import Path
import shutil
import subprocess
import tempfile

parser=argparse.ArgumentParser()
parser.add_argument('--node',required=True)
parser.add_argument('--source',required=True)
a=parser.parse_args()
root=Path(__file__).resolve().parent
mutations=[
 ('draft_binding', 'equal(draft.notes, current.notes)', 'true'),
 ('inventory_heads', 'equal(inventory, heads)', 'true'),
 ('prepared_cutoff', 'status.cutoff === prepared.cutoff', 'true'),
 ('source_histories', 'equal(old, draft.records)', 'true'),
 ('stopped_engine', "['ABSENT', 'STOPPED'].includes(current.engineState)", 'true'),
 ('catalog_hash', 'commit.catalogHash === status.catalog_hash', 'true'),
 ('destination_union', 'equal(current.records.map(r => r.fileId), expected)', 'true'),
 ('destination_history', 'equal(next.heads, next.versions)', 'true'),
 ('restart_disk_bytes', 'equal(prior.disk, current.disk)', 'true'),
 ('restart_histories', 'equal(select(prior), select(current))', 'true'),
 ('pending_list_route', "if (pending) {\n      stage = 'rotation_status';", "if (false) {\n      stage = 'rotation_status';"),
]
with tempfile.TemporaryDirectory(prefix='obsync-checkpoint-mutations-') as tmp:
 work=Path(tmp)/'scripts/validation/mobile';work.mkdir(parents=True)
 for name in ('native-checkpoint.mjs','native-checkpoint.test.mjs','desktop-guard.mjs','cdp.mjs','ciphertext-oracle.mjs'):
  shutil.copyfile(root/name,work/name)
 shutil.copyfile(root.parent/'mobile-full.py',work.parent/'mobile-full.py')
 target=work/'native-checkpoint.mjs';baseline=target.read_text()
 env=__import__('os').environ|{'OBSYNC_ORACLE_SOURCE':str(Path(a.source).resolve())}
 def check():
  return subprocess.run([a.node,'--test',str(work/'native-checkpoint.test.mjs')],env=env,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL).returncode
 if check()!=0:raise SystemExit('checkpoint mutation baseline must pass')
 killed=[]
 for name,old,new in mutations:
  if baseline.count(old)!=1:raise SystemExit('mutation target must be unique: '+name)
  target.write_text(baseline.replace(old,new))
  if check()==0:raise SystemExit('checkpoint mutation survived: '+name)
  killed.append(name);target.write_text(baseline)
 # The actual full-sequence test must detect loss of pre-prepare inventory wiring.
 full=work.parent/'mobile-full.py';before=full.read_text()
 line="    native('rotation-draft-complete-inventory', 'native-checkpoint.mjs', 'rotation-draft', results=('OBSERVED',))\n"
 if before.count(line)!=1:raise SystemExit('draft wiring mutation target must be unique')
 full.write_text(before.replace(line,''))
 if check()==0:raise SystemExit('checkpoint wiring mutation survived')
 killed.append('draft_wiring');full.write_text(before)
 # Fixed rotation module binding must not silently turn into an unbound require.
 module=work/'ciphertext-oracle.mjs';before=module.read_text()
 line="  if (rotationModules) for (const name of ['./rotationWire', './rotationReseal']) bind(name);\n"
 if before.count(line)!=1:raise SystemExit('rotation binding mutation target must be unique')
 module.write_text(before.replace(line,''))
 if check()==0:raise SystemExit('rotation closure mutation survived')
 killed.append('rotation_module_binding')
 print(json.dumps({'result':'PASS','kind':'OFFLINE_MUTATION_CONTROLS','nativeAcceptance':False,'killed':killed,'count':len(killed)}))
