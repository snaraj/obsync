#!/usr/bin/env python3
"""Finite offline socket lifecycle guards; no Android or native application calls."""
import argparse,json,shutil,subprocess,tempfile
from pathlib import Path
p=argparse.ArgumentParser();p.add_argument('--node',required=True);a=p.parse_args()
root=Path(__file__).resolve().parent
mutations=[
 ('single_handshake_cap','started+15000','started+30000'),
 ('handshake_remaining_budget','Math.min(deadline,started+15000)','started+15000'),
 ('early_close_refusal',"finish(Error('owned CDP closed before handshake'));",'finish(null);'),
 ('late_open_refusal',"finish(now()<end?null:Error('owned CDP handshake deadline'));",'finish(null);'),
 ('await_close','else await new Promise((resolve,reject)=>{','else void new Promise((resolve,reject)=>{'),
 ('one_close_only','if(socket.readyState!==2){','if(true){'),
 ('completed_close_required',"if(!facts.closeObserved||socket.readyState!==3||now()>=closeEnd)throw Error('owned CDP close deadline');",'void 0;'),
 ('close_cap','Math.min(end,started+2000)','Math.min(end,started+4000)'),
 ('total_release_budget','started+20000','started+40000'),
 ('remaining_forward_budget','await removeForward(remaining);','await removeForward(20000);'),
 ('late_forward_refusal',"if(now()>=end)failure??=Error('owned CDP release deadline');",'void 0;'),
 ('listeners_on_throw',"if(closeListener)socket.removeEventListener('close',closeListener);if(errorListener)socket.removeEventListener('error',errorListener);",'void 0;'),
 ('finally_await_release','try {await releaseConnection();}', 'try {void releaseConnection();}'),
 ('normal_default_allowance','connect(deadline=state.expiresAtEpoch*1000)','connect(deadline=Date.now()+45000)'),
 ('startup_no_transport_retry','      appPid=await connect(end);','      try{appPid=await connect(end);}catch(error){appPid=await connect(end);}'),
 ('startup_final_deadline',"if(!appPid||Date.now()>=end)throw Error('owned vault WebView startup deadline');","if(!appPid)throw Error('owned vault WebView startup deadline');"),
 ('connection_remaining_deadline',"if(value<=0)throw Error('owned Android connection deadline');",'void 0;'),
 ('connection_ws_deadline','await waitOwnedSocketOpen(ws,connectReadiness,end);','await waitOwnedSocketOpen(ws,connectReadiness,state.expiresAtEpoch*1000);'),
 ('page_remaining_read_budget','const all=await read(Math.max(1,end-now()));','const all=await read(20000);'),
 ('page_remaining_pause_budget','    if(now()<end)await pause(Math.min(100,end-now()));\n  }while(now()<end);','    if(now()<end)await pause(100);\n  }while(now()<end);'),
 ('connection_fetch_deadline','AbortSignal.timeout(Math.max(1,Math.floor(Math.min(5000,budget,remaining()))))','AbortSignal.timeout(5000)'),
 ('first_http_failure_retained','connectReadiness.firstHttpFailure??=request;throw error;','throw error;'),
]
with tempfile.TemporaryDirectory(prefix='obsync-cdp-mutations-') as tmp:
 work=Path(tmp)/'scripts/validation';(work/'mobile').mkdir(parents=True)
 for name in ('android-journey.mjs','mobile/cdp.mjs','mobile/android-cdp-lifecycle.test.mjs','mobile/android-connect.test.mjs'):shutil.copyfile(root/name,work/name)
 target=work/'android-journey.mjs';baseline=target.read_text()
 def check():
  return subprocess.run([a.node,'--test','--test-isolation=none',str(work/'mobile/android-cdp-lifecycle.test.mjs'),str(work/'mobile/android-connect.test.mjs')],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=10).returncode
 if check()!=0:raise SystemExit('socket lifecycle mutation baseline must pass')
 killed=[]
 for name,old,new in mutations:
  if baseline.count(old)!=1:raise SystemExit('mutation target mismatch: '+name)
  target.write_text(baseline.replace(old,new))
  if check()==0:raise SystemExit('socket lifecycle mutation survived: '+name)
  killed.append(name);target.write_text(baseline)
 print(json.dumps({'result':'PASS','kind':'OFFLINE_CDP_LIFECYCLE_MUTATION_CONTROLS','nativeAcceptance':False,'count':len(killed),'killed':killed}))
