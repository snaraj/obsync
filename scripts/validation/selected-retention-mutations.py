#!/usr/bin/env python3
"""Finite offline retained-evidence mutants. Timeout is a failure, never a kill."""
import argparse
import json
import os
from pathlib import Path
import subprocess
import tempfile

p=argparse.ArgumentParser();p.add_argument('--node',required=True);a=p.parse_args()
here=Path(__file__).resolve().parent
full=(here/'mobile-full.py').read_text();desktop=(here/'mobile/selected-desktop.mjs').read_text();admission=(here/'mobile-acceptance.py').read_text()
mutants=[
 ('recovery_terminal_admission',admission,'    full.recovery_evidence(run, source_head)','    pass'),
 ('recovery_expected_source',full,"expected.get('sourceHead') == source_head",'True'),
 ('recovery_result_source',full,"result.get('sourceHead') == source_head\n         and result.get('expectationsSha256')", "True\n         and result.get('expectationsSha256')"),
 ('recovery_manifest_digest',full,"result.get('expectationsSha256') == hashlib.sha256(manifest).hexdigest()",'True'),
 ('recovery_expected_count',full,"result['expectedCount'] == 2",'True'),
 ('recovery_exported_count',full,"result['exportedCount'] == 2",'True'),
 ('recovery_actual_hash',full,"entry.get('actualSha256') == note['sha256'] == hashlib.sha256(data).hexdigest()","entry.get('actualSha256') == note['sha256']"),
 ('recovery_export_path',full,"entry.get('path') == 'evidence/recovery-C-readback/' + str(i) + '-desktop.bin'",'True'),
 ('recovery_export_generation',full,"entry.get('generation') == note['generation']",'True'),
 ('recovery_exact_match',full,"entry.get('exactHashMatched') is True",'True'),
 ('terminal_admission',admission,'    full.selected_evidence(run, source_head)','    pass'),
 ('android_bytes',full,"need(raw(root + '/' + str(i) + '-android.bin', 65536) == expected",'need(True'),
 ('desktop_bytes',full,"and raw(root + '/' + str(i) + '-desktop.bin', 65536) == expected)",')'),
 ('manifest_digest',full,"hashlib.sha256(fixture_raw).hexdigest() == entry.get('fixtureManifestSha256')",'True'),
 ('result_digest',full,"hashlib.sha256(result_raw).hexdigest() == entry.get('resultSha256')",'True'),
 ('result_source',full,"result.get('sourceHead') == source_head\n             and result.get('fixtureManifestSha256')","True\n             and result.get('fixtureManifestSha256')"),
 ('snapshot_digest',full,"hashlib.sha256(data).hexdigest() == entry.get('sha256')",'True'),
 ('snapshot_length',full,"len(data) == entry.get('bytes')",'True'),
 ('snapshot_source',full,"snapshot.get('sourceHead') == source_head",'True'),
 ('fixed_paths',full,"entry.get('resultPath') == root + '/result.json' and entry.get('fixtureManifestPath') == root + '-fixtures.json'",'True'),
 ('down_export_wiring',full,"    selected_bytes('down', 'team docs')",'    pass'),
 ('snapshot_validation',desktop,'  checkedSnapshot(value);','  // omitted validation'),
 ('quiet_endpoint_wiring',desktop,"    retainedSnapshots.push(retainSelectedSnapshot(state.run,command==='watch-down'?'quiet-down':'quiet-up',finalSnapshot));",'    // omitted endpoint'),
]
killed=[]
for name,source,old,new in mutants:
 if source.count(old)!=1:raise RuntimeError('ambiguous mutant '+name)
 suffix='.mjs' if source is desktop else '.py'
 # Node relative imports stay task-owned; the mutated file is removed in finally.
 parent=here if suffix=='.py' else here/'mobile'
 fd,path=tempfile.mkstemp(prefix='selected-mutant-',suffix=suffix,dir=parent);os.close(fd);path=Path(path)
 try:
  path.write_text(source.replace(old,new,1));env=dict(os.environ)
  if suffix=='.py':
   for prefix in ('OBSYNC_SELECTED_', 'OBSYNC_RECOVERY_'):env[prefix+('FULL_SOURCE' if source is full else 'ADMISSION_SOURCE')]=str(path)
   cmd=['python3','-B','-m','unittest','discover','-s',str(here),'-p','test_mobile_*retention.py']
  else:env['OBSYNC_SELECTED_RETENTION_MODULE']=str(path);cmd=[a.node,'--test',str(here/'mobile/selected-retention.test.mjs')]
  result=subprocess.run(cmd,env=env,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,timeout=10)
  if result.returncode==0:raise RuntimeError('survived mutant '+name)
  if b'SyntaxError' in result.stdout or b'ImportError' in result.stdout:raise RuntimeError('invalid mutant '+name)
  killed.append(name)
 finally:path.unlink(missing_ok=True)
print(json.dumps({'result':'PASS','kind':'OFFLINE_SELECTED_RETENTION_MUTATION_CONTROLS','nativeAcceptance':False,'count':len(killed),'killed':killed}))
