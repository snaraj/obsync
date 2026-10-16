"""Broken controls for owned transport selection and retained provenance; no native calls."""
import argparse,importlib.util,io,json,tempfile,types,unittest
from pathlib import Path
from unittest.mock import patch

def load(path,name):
 spec=importlib.util.spec_from_file_location(name,path);module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module

def main(argv=None):
 parser=argparse.ArgumentParser();parser.add_argument('--node',required=True);args=parser.parse_args(argv);b=Path(__file__).parent;results=[]
 routes=load(b/'test_android_tcp.py','route_mutation_cases');budget=load(b/'test_android_tcp_budget.py','budget_mutation_cases');retained=load(b/'test_android_tcp_evidence.py','retained_mutation_cases');deadlines=load(b/'test_android_tcp_deadlines.py','deadline_mutation_cases')
 cases=[
  ('network-policy-refusal',routes,'T','emulator-tcp.py',"if not proof['mobileDataGlobalSettingZero'] or proof['ipv4RouteIsolation']['extraEgressRoutes']:",'if False:',routes.Route,'test_initial_uses_verified_wifi_backend_and_one_standard_connect_with_independent_routes'),
  ('effective-backends',routes,'T','emulator-tcp.py',"if not proof['effectiveNetworkOptions']['ready']:raise ValueError('effective restricted backends not observed')","if False:raise ValueError('effective restricted backends not observed')",routes.Route,'test_initial_uses_verified_wifi_backend_and_one_standard_connect_with_independent_routes'),
  ('different-guest',routes,'T','emulator-tcp.py','if before!=after:','if False:',routes.Route,'test_initial_uses_verified_wifi_backend_and_one_standard_connect_with_independent_routes'),
  ('dummy-route',routes,'T','emulator-tcp.py',"if line.strip() not in expected:raise ValueError('dummy_route_unknown')","if False:raise ValueError('dummy_route_unknown')",routes.Route,'test_dummy_requires_native_kind_and_fixed_default_discard_route'),
  ('receipt-millisecond-unit',routes,'T','emulator-tcp.py',"'commandCapMs':cap*1000","'commandCapMs':cap",routes.Route,'test_initial_uses_verified_wifi_backend_and_one_standard_connect_with_independent_routes'),
  ('exact-provisioning-argv',budget,'T','emulator-tcp.py','tuple(args) not in FRAMEWORK_PROVISIONING','False',budget.Budget,'test_exact_framework_allowlist_only_and_owned_target'),
  ('late-command',budget,'T','emulator-tcp.py',' remaining(operation_end)\n','\n',budget.Budget,'test_same_boot_deadline_clips_framework_and_late_success_refuses'),
  ('reboot-ready-before-commit',routes,'T','emulator-tcp.py'," if phase=='reboot' and command(state,env,target,['shell','getprop','sys.boot_completed'],end)!='1':return False\n",'',routes.Route,'test_reboot_two_polls_does_not_commit_new_boot_until_boot_complete'),
  ('late-binding-save',routes,'T','emulator-tcp.py',' save_binding(state,run,port,current,phase,save,original,route_proof)\n remaining(end)',' save_binding(state,run,port,current,phase,save,original,route_proof)',routes.Route,'test_save_returning_late_is_failure_even_when_private_binding_was_written'),
  ('selected-target',routes,'S','android-session.py',"state['serial'] if state.get('targetKind')=='usb' else emulator_target(state)","state['serial']",routes.Route,'test_actual_session_command_uses_selected_target_and_failed_read_once'),
  ('retained-phase-count',retained,'M','mobile-acceptance.py',"need([phase for _,phase,_ in ordered]==(['initial','root'] if mode=='core' else ['initial','root','reboot','root']))",'need(True)',retained.Retained,'test_missing_phase_wrong_source_or_changed_chain_refuses'),
  ('retained-root-zero-uid',retained,'M','mobile-acceptance.py'," and (phase!='root' or route['adbdUid']==0)",'',retained.Retained,'test_root_receipt_must_prove_actual_zero_uid'),
  ('retained-prior-guest',retained,'M','mobile-acceptance.py',"and row.get('priorGuest')==prior and isinstance(guest,dict)","and isinstance(guest,dict)",retained.Retained,'test_missing_phase_wrong_source_or_changed_chain_refuses'),
 ]
 for name,case,binding,file,old,new,cls,method in cases:
  source=(b/file).read_text();assert source.count(old)==1,(name,source.count(old));module=types.ModuleType('owned_tcp_mutant');module.__file__=str(b/file);exec(compile(source.replace(old,new,1),str(b/file),'exec'),module.__dict__);out=io.StringIO()
  with patch.object(case,binding,module):r=unittest.TextTestRunner(stream=out).run(unittest.TestSuite([cls(method)]))
  assert len(r.failures)==1 and not r.errors,(name,out.getvalue());results.append({'mutation':name,'assertionKilled':True})
 # The actual root deadline assignments must retain the session TTL boundary.
 with tempfile.TemporaryDirectory(prefix='obsync-tcp-root-deadline-') as tmp:
  root=Path(tmp);source=(b/'android-trust.py').read_text();old="    if state.get('adbTransport')=='isolated-tcp':deadline=min(deadline,time.monotonic()+max(0,state['expiresAtEpoch']-time.time()))\n";assert source.count(old)==1;(root/'android-trust.py').write_text(source.replace(old,''));out=io.StringIO()
  with patch.object(deadlines,'B',root):r=unittest.TextTestRunner(stream=out).run(unittest.TestSuite([deadlines.Callers('test_actual_root_deadline_is_clipped_to_session_expiry')]))
  assert len(r.failures)==1 and not r.errors,out.getvalue();results.append({'mutation':'root-session-expiry','assertionKilled':True})
 # Execute the actual Node target/driver controls against isolated altered helper files.
 import subprocess
 for name,old,new in [('node-selected-target',"return mode==='isolated-tcp'?selectedTarget(state):state.serial;",'return state.serial;'),('node-listener-owner','pids[0]!==state.processes.emulator.pid','false')]:
  source=(b/'tcp-target.mjs').read_text();assert source.count(old)==1
  with tempfile.TemporaryDirectory(prefix='obsync-tcp-mutant-') as tmp:
   root=Path(tmp)
   for file in ('android-tcp.test.mjs','android-journey.mjs'):(root/file).write_bytes((b/file).read_bytes())
   (root/'tcp-target.mjs').write_text(source.replace(old,new,1));r=subprocess.run([args.node,'--test',str(root/'android-tcp.test.mjs')],stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True,timeout=10)
   assert r.returncode and 'ERR_ASSERTION' in r.stdout,(name,r.stdout);results.append({'mutation':name,'assertionKilled':True})
 print(json.dumps({'result':'PASS','count':len(results),'mutations':results}));return 0

if __name__=='__main__':raise SystemExit(main())
