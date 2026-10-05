#!/usr/bin/env python3
"""Three counterbalanced pairs of fresh native runs; all results retained."""
import argparse,json,os,select,subprocess,sys,threading
from pathlib import Path

p=argparse.ArgumentParser(description=__doc__)
p.add_argument('--source',type=Path,required=True);p.add_argument('--binary',type=Path,required=True)
p.add_argument('--harness',type=Path,required=True);p.add_argument('--root',type=Path,required=True)
p.add_argument('--baseline',type=Path,required=True);p.add_argument('--candidate',type=Path,required=True)
a=p.parse_args();os.umask(0o077)
os.environ['OBSYNC_LAB_SOURCE']=str(a.source.resolve())
sys.path.insert(0,str(a.harness.resolve()))
from performance import finish_sample

samples=[]
for index,arm in enumerate(['baseline','candidate','candidate','baseline','baseline','candidate'],1):
    run=a.root/f'{index}-{arm}'
    if run.exists():raise RuntimeError('sample exists; refusing replacement')
    command=[sys.executable,'-B',str(a.harness/'lab.py'),'up','--run',str(run),'--source-repo',str(a.source),
      '--binary',str(a.binary),'--plugin',str(getattr(a,arm)),'--hold']
    holder=subprocess.Popen(command,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True)
    record={'sample':index,'arm':arm,'result':'FAIL'}
    stage='startup'
    try:
        if not select.select([holder.stdout],[],[],90)[0]:raise TimeoutError('native startup deadline')
        if json.loads(holder.stdout.readline()).get('ready') is not True:raise RuntimeError('native not ready')
        with (run/'private/driver.log').open('w') as log:
            for stage in ['init','setup-first','pair']:
                subprocess.run(['node',str(a.harness/'journeys.mjs'),str(run),stage],check=True,stdout=log,stderr=log,timeout=180)
            stage='comparison'
            subprocess.run(['node',str(Path(__file__).with_name('native-overlap.mjs')),str(run),str(a.harness)],check=True,stdout=log,stderr=log,timeout=300)
        result=json.loads((run/'evidence/overlap.json').read_text())
        if result.get('result')!='SCENARIO_PASS' or result.get('hooksRemoved') is not True:raise RuntimeError('native scenario incomplete')
        record['scenarioPass']=True
    except BaseException as error:
        record['failure']=type(error).__name__
        record['failureStage']=stage
    finally:
        try:
            finish_sample(run,holder,None,threading.Event())
            record['cleanupCompleted']=True
        except BaseException as error:
            record['cleanupFailure']=type(error).__name__
        if record.get('scenarioPass') and record.get('cleanupCompleted'):record['result']='PASS'
        samples.append(record)
        (a.root/'evidence/native-samples.json').write_text(json.dumps(samples,indent=2)+'\n')
        print(json.dumps(record),flush=True)
    if record['result']!='PASS':raise SystemExit('sample failed; retained, no later sample started')
print('ALL_SAMPLES_COMPLETE')
