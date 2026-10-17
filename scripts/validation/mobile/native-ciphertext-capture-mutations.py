#!/usr/bin/env python3
"""Finite offline capture mutations; no runtime/device operations."""
import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile

p=argparse.ArgumentParser()
p.add_argument('--node',required=True)
p.add_argument('--source',required=True)
a=p.parse_args()
root=Path(__file__).resolve().parent
mutations=[
 ('readiness_paired', 'observation.paired && observation.activeSuite2', 'true && observation.activeSuite2'),
 ('readiness_active_suite', '&& observation.activeSuite2 &&', '&& true &&'),
 ('readiness_server', '&& observation.serverMatches &&', '&& true &&'),
 ('readiness_generation', 'pin?.generation === P.mapFileId && context?.generation === pin?.generation', 'true'),
 ('readiness_map', 'mapMatches: context?.mapFileId === P.mapFileId', 'mapMatches: true'),
 ('readiness_present_identity', 'if (observation.identityPresent && !observation.identityValid)', 'if (false)'),
 ('readiness_identity_format', "!!local && /^[a-f0-9]{32}$/.test(local.fileId) && /^[a-f0-9]{64}$/.test(local.versionId)", '!!local'),
 ('readiness_product_status', 'if (!observation.statusPermitsPublication)', 'if (false)'),
 ('readiness_idle', 'ready: observation.idle && observation.identityValid', 'ready: observation.identityValid'),
 ('readiness_identity_required', 'ready: observation.idle && observation.identityValid', 'ready: observation.idle'),
 ('readiness_required', 'if (value.ready) { onReady();', 'if (true) { onReady();'),
 ('readiness_30s_cap', 'started + 30000', 'started + 60000'),
 ('readiness_remaining_budget', 'Math.min(deadline, started + 30000)', 'started + 30000'),
 ('late_success', 'if (now() >= deadline) throw failure();', 'if (false) throw failure();'),
 ('native_note_head', 'noteHead.heads.length!==1||noteHead.heads[0]!==local.versionId', 'false'),
 ('native_map_head', 'file.heads.length!==1||file.versions.length>16', 'false'),
 ('native_record_unchanged', 'before!==after||', 'false||'),
 ('native_after_heads', 'JSON.stringify(noteHead)!==JSON.stringify(P.before.note)||JSON.stringify(mapHead)!==JSON.stringify(P.before.map)', 'false'),
 ('native_after_stability', 'p.state.custody2()?.generation!==P.generation||p.state.fileByPath(P.path)?.versionId!==P.versionId', 'false'),
 ('safe_failure_stage', "stage = 'native_note_version';", "stage = 'native_map_current_head';"),
]
with tempfile.TemporaryDirectory(prefix='obsync-capture-mutations-') as temporary:
 work=Path(temporary)
 for name in ('native-ciphertext-capture.mjs','native-ciphertext-capture.test.mjs','desktop-guard.mjs','cdp.mjs','ciphertext-oracle.mjs','ciphertext-retention.mjs'):
  shutil.copyfile(root/name,work/name)
 target=work/'native-ciphertext-capture.mjs'
 baseline=target.read_text()
 env=os.environ|{'OBSYNC_ORACLE_SOURCE':str(Path(a.source).resolve())}
 def check():
  return subprocess.run([a.node,'--test','--test-isolation=none',str(work/'native-ciphertext-capture.test.mjs')],env=env,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=10).returncode
 if check()!=0:raise SystemExit('capture mutation baseline must pass')
 killed=[]
 for name,old,new in mutations:
  if baseline.count(old)!=1:raise SystemExit('mutation target must be unique: '+name)
  target.write_text(baseline.replace(old,new))
  if check()==0:raise SystemExit('capture mutation survived: '+name)
  killed.append(name);target.write_text(baseline)
 print(json.dumps({'result':'PASS','kind':'OFFLINE_MUTATION_CONTROLS','nativeAcceptance':False,'killed':killed,'count':len(killed)}))
