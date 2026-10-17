"""Broken controls for owned transport selection and retained provenance; no native calls."""
import argparse,importlib.util,io,json,tempfile,types,unittest
from pathlib import Path
from unittest.mock import patch

def load(path,name):
 spec=importlib.util.spec_from_file_location(name,path);module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module

def observation_mutations(b):
 # The existing actual helper and extracted loop provide the failure oracles.
 observed=load(b/'test_reboot_observation.py','observation_mutation_cases');results=[]
 changes=[
  ('observation-receipt-omitted',"                try:save(run/'evidence/owned-reboot-reattachment-observation.json',observation)",'                try:pass'),
  ('observation-failed-terminal-lost',"observation['terminal']='FAILED'","observation['terminal']='NOT_REACHED'"),
  ('observation-first-overwritten',"row['count']+=1;row['last']=facts","row['count']+=1;row['first']=facts;row['last']=facts"),
  ('observation-last-stale',"row['count']+=1;row['last']=facts","row['count']+=1"),
 ]
 for name,old,new in changes:
  source=(b/'android-session.py').read_text();assert source.count(old)==1,name;changed=source.replace(old,new,1);compile(changed,str(b/'android-session.py'),'exec')
  with tempfile.TemporaryDirectory(prefix='obsync-reboot-observation-') as tmp:
   root=Path(tmp);(root/'android-session.py').write_text(changed);out=io.StringIO()
   with patch.object(observed,'B',root):r=unittest.TextTestRunner(stream=out).run(unittest.TestSuite([observed.Observation('test_actual_loop_retains_one_bounded_first_last_file_after_deadline')]))
  assert len(r.failures)==1 and not r.errors,(name,out.getvalue());results.append({'mutation':name,'assertionKilled':True})
 source=(b/'emulator-tcp.py').read_text()
 error_line="facts.update(result='ERROR',exceptionType=type(error).__name__ if isinstance(error,(OSError,subprocess.SubprocessError,ValueError,TimeoutError,ExpectedAttachmentPending)) else 'UNCLASSIFIED')"
 changes=[
  ('observation-raw-exception-leak',error_line,error_line+";facts['errorText']=str(error)"),
  ('observation-error-type-omitted',error_line,"facts.update(result='ERROR')"),
  ('observation-closed-command-classification-lost',"  if isinstance(error,(subprocess.CalledProcessError,subprocess.TimeoutExpired)) and failure_classifier is not None:facts['commandFailure']=failure_classifier(error)\n",''),
 ]
 for name,old,new in changes:
  assert source.count(old)==1,name;module=types.ModuleType('observation_helper_mutant');module.__file__=str(b/'emulator-tcp.py');exec(compile(source.replace(old,new,1),module.__file__,'exec'),module.__dict__);out=io.StringIO()
  with patch.object(observed,'T',module),patch.object(observed.S,'TCP',module):r=unittest.TextTestRunner(stream=out).run(unittest.TestSuite([observed.Observation('test_transport_failure_class_and_incoming_step_are_retained_without_error_text')]))
  assert len(r.failures)==1 and not r.errors,(name,out.getvalue());results.append({'mutation':name,'assertionKilled':True})
 return results

def wifi_restore_mutations(b):
 results=[];source=(b/'emulator-tcp.py').read_text()
 changes=[
  ('wifi-known-network-required',"if not proof['initialSyntheticWifi']['exactKnownNetworkConnected']:",'if False:','test_initial_gate_requires_exact_one_enabled_synthetic_network'),
  ('wifi-user-unlock-required',"if value!='RUNNING_UNLOCKED':",'if False:','test_locked_wait_then_unlocked_issues_one_original_request_across_attempts'),
  ('wifi-refusal-is-terminal',"not in ('EMPTY','INITIATED')","not in ('EMPTY','INITIATED','REFUSED')",'test_failure_timeout_refusal_or_late_result_is_terminal_without_second_request'),
  ('wifi-first-observation-immutable',"facts['wifiRestoration']=json.loads(json.dumps(proof))","facts['wifiRestoration']=proof",'test_prior_unlock_observation_is_immutable_after_later_request'),
 ]
 for name,old,new,method in changes:
  assert old in source,name
  with tempfile.TemporaryDirectory(prefix='obsync-wifi-restoration-') as tmp:
   root=Path(tmp)
   for file in ('android-session.py','android-apk.py','test_android_tcp_wifi_restore.py'):(root/file).write_bytes((b/file).read_bytes())
   (root/'emulator-tcp.py').write_text(source.replace(old,new));case=load(root/'test_android_tcp_wifi_restore.py','wifi_restoration_mutant');out=io.StringIO()
   result=unittest.TextTestRunner(stream=out).run(unittest.TestSuite([case.Restore(method)]))
  assert len(result.failures)==1 and not result.errors,(name,out.getvalue());results.append({'mutation':name,'assertionKilled':True})
 source=(b/'mobile-acceptance.py').read_text();start=source.index("        path=evidence/'owned-reboot-reattachment-observation.json'");end=source.index("        refs[str(path.relative_to(android))]=sha(path)",start)+len("        refs[str(path.relative_to(android))]=sha(path)\n")
 module=types.ModuleType('retained_wifi_witness_mutant');module.__file__=str(b/'mobile-acceptance.py');exec(compile(source[:start]+source[end:],module.__file__,'exec'),module.__dict__)
 case=load(b/'test_android_tcp_evidence.py','retained_wifi_omission_control');out=io.StringIO()
 with patch.object(case,'M',module):result=unittest.TextTestRunner(stream=out).run(unittest.TestSuite([case.Retained('test_full_requires_bound_single_wifi_restoration_after_cleanup')]))
 assert len(result.failures)==1 and not result.errors,out.getvalue();results.append({'mutation':'wifi-required-retained-witness-omitted','assertionKilled':True})
 return results

def incoming_reboot_mutations(b):
 # Actual incoming frame and retained admission controls, all native boundaries mocked.
 kernel=load(b/'test_android_tcp_route.py','incoming_reboot_mutation_cases')
 retained=load(b/'test_android_tcp_evidence.py','incoming_retained_mutation_cases');results=[]
 changes=[
  ('runtime_partial_frame_admitted', 'emulator-tcp.py', "if len(lines)!=6 or lines[-1]!=b'OBSYNC_INCOMING_GUEST_COMPLETE\\n':raise ValueError('incoming_guest_framing')", "if False:raise ValueError('incoming_guest_framing')", 'test_partial_frame_uid_parse_guest_change_bad_response_or_late_command_never_binds'),
  ('runtime_mixed_uid_admitted', 'emulator-tcp.py', "if len(matches)!=1 or len(set(matches[0]))!=1:raise ValueError('adbd_uid_unknown')", "if len(matches)!=1:raise ValueError('adbd_uid_unknown')", 'test_partial_frame_uid_parse_guest_change_bad_response_or_late_command_never_binds'),
  ('runtime_foreign_guest_admitted', 'emulator-tcp.py', "if original!=current or (phase=='root' and current['bootIdSha256']!=prior['bootIdSha256']):raise ValueError('expected lifecycle TCP guest differs')", "if phase=='root' and current['bootIdSha256']!=prior['bootIdSha256']:raise ValueError('expected lifecycle TCP guest differs')", 'test_partial_frame_uid_parse_guest_change_bad_response_or_late_command_never_binds'),
  ('runtime_missing_connect_response_admitted', 'emulator-tcp.py', "if phase=='reboot' and response not in ('connected to '+target,'already connected to '+target):raise ValueError('reboot connect response missing')", "if False:raise ValueError('reboot connect response missing')", 'test_partial_frame_uid_parse_guest_change_bad_response_or_late_command_never_binds'),
  ('false_reboot_mark_zero_prerequisite_restored', 'emulator-tcp.py', "if phase=='root':response_route_ready(state,env,state['serial'],original,end,route_proof,read=route_read)", "if phase in ('root','reboot'):response_route_ready(state,env,state['serial'],original,end,route_proof,read=route_read)", 'test_actual_incoming_frame_replaces_only_reboot_mark_zero_prerequisite'),
  ('retained_response_omitted', 'mobile-acceptance.py', "and route.get('connectResponse') in ('connected to '+current[0],'already connected to '+current[0])", '', 'test_reboot_requires_actual_frame_uid_listener_boot_and_deadline_after_cleanup'),
  ('retained_uid_unbound', 'mobile-acceptance.py', "and incoming['adbdUid']==route['adbdUid']", '', 'test_reboot_requires_actual_frame_uid_listener_boot_and_deadline_after_cleanup'),
  ('retained_listener_owner_unbound', 'mobile-acceptance.py', "listener.get('pid')==current[2] and listener.get('address')==current[0]", "listener.get('address')==current[0]", 'test_reboot_requires_actual_frame_uid_listener_boot_and_deadline_after_cleanup'),
  ('retained_selected_boot_proof_omitted', 'mobile-acceptance.py', "for name in ('originalBootCompleted','selectedBootCompleted'):", "for name in ('originalBootCompleted',):", 'test_reboot_requires_actual_frame_uid_listener_boot_and_deadline_after_cleanup'),
  ('retained_deadline_flag_omitted', 'mobile-acceptance.py', "route.get('phaseDeadlineMet') is True and route.get('connectCapMs')==12000", "route.get('connectCapMs')==12000", 'test_reboot_requires_actual_frame_uid_listener_boot_and_deadline_after_cleanup'),
 ]
 for name,file,old,new,method in changes:
  source=(b/file).read_text();assert source.count(old)==1,(name,source.count(old));module=types.ModuleType('incoming_reboot_mutant');module.__file__=str(b/file);exec(compile(source.replace(old,new,1),module.__file__,'exec'),module.__dict__);out=io.StringIO()
  case,binding,cls=(kernel,'T',kernel.IncomingReboot) if file=='emulator-tcp.py' else (retained,'M',retained.Retained)
  with patch.object(case,binding,module):r=unittest.TextTestRunner(stream=out).run(unittest.TestSuite([cls(method)]))
  assert r.failures and not r.errors,(name,out.getvalue());results.append({'mutation':name,'assertionKilled':True})
 return results

def main(argv=None):
 parser=argparse.ArgumentParser();parser.add_argument('--node',required=True);args=parser.parse_args(argv);b=Path(__file__).parent;results=[]
 routes=load(b/'test_android_tcp.py','route_mutation_cases');budget=load(b/'test_android_tcp_budget.py','budget_mutation_cases');retained=load(b/'test_android_tcp_evidence.py','retained_mutation_cases');deadlines=load(b/'test_android_tcp_deadlines.py','deadline_mutation_cases')
 cases=[
  ('early-data-selected-route-only',budget,'T','emulator-tcp.py'," and state.get('selectedTcpAdb') is None and tuple(args) in"," and tuple(args) in",budget.Budget,'test_early_data_original_target_requires_isolated_unselected_and_exact_argv'),
  ('network-policy-refusal',routes,'T','emulator-tcp.py',"if not proof['mobileDataGlobalSettingZero'] or proof['ipv4RouteIsolation']['extraEgressRoutes']:",'if False:',routes.Route,'test_initial_uses_verified_wifi_backend_and_one_standard_connect_with_independent_routes'),
  ('effective-backends',routes,'T','emulator-tcp.py',"if not proof['effectiveNetworkOptions']['ready']:raise ValueError('effective restricted backends not observed')","if False:raise ValueError('effective restricted backends not observed')",routes.Route,'test_initial_uses_verified_wifi_backend_and_one_standard_connect_with_independent_routes'),
  ('different-guest',routes,'T','emulator-tcp.py','if before!=after:','if False:',routes.Route,'test_initial_uses_verified_wifi_backend_and_one_standard_connect_with_independent_routes'),
  ('dummy-route',routes,'T','emulator-tcp.py',"if line.strip() not in expected:raise ValueError('dummy_route_unknown')","if False:raise ValueError('dummy_route_unknown')",routes.Route,'test_dummy_requires_native_kind_and_fixed_default_discard_route'),
  ('receipt-millisecond-unit',routes,'T','emulator-tcp.py',"'commandCapMs':cap*1000","'commandCapMs':cap",routes.Route,'test_initial_uses_verified_wifi_backend_and_one_standard_connect_with_independent_routes'),
  ('exact-provisioning-argv',budget,'T','emulator-tcp.py','tuple(args) not in FRAMEWORK_PROVISIONING','False',budget.Budget,'test_exact_framework_allowlist_only_and_owned_target'),
  ('late-command',budget,'T','emulator-tcp.py',' remaining(operation_end)\n','\n',budget.Budget,'test_same_boot_deadline_clips_framework_and_late_success_refuses'),
  ('reboot-ready-before-commit',routes,'T','emulator-tcp.py',"   if value!='1':facts['pendingReason']='SELECTED_BOOT_NOT_COMPLETED';return False\n",'',routes.Route,'test_reboot_two_polls_does_not_commit_new_boot_until_boot_complete'),
  ('late-binding-save',routes,'T','emulator-tcp.py','  save_binding(state,run,port,current,phase,save,original,route_proof);remaining(end)','  save_binding(state,run,port,current,phase,save,original,route_proof)',routes.Route,'test_save_returning_late_is_failure_even_when_private_binding_was_written'),
  ('selected-target',routes,'S','android-session.py',"state['serial'] if state.get('targetKind')=='usb' else emulator_target(state)","state['serial']",routes.Route,'test_actual_session_command_uses_selected_target_and_failed_read_once'),
  ('retained-phase-count',retained,'M','mobile-acceptance.py',"need([phase for _,phase,_ in ordered]==(['initial','root'] if mode=='core' else ['initial','root','reboot','root']))",'need(True)',retained.Retained,'test_missing_phase_wrong_source_or_changed_chain_refuses'),
  ('retained-root-zero-uid',retained,'M','mobile-acceptance.py'," and (phase!='root' or route['adbdUid']==0)",'',retained.Retained,'test_root_receipt_must_prove_actual_zero_uid'),
  ('retained-prior-guest',retained,'M','mobile-acceptance.py',"and row.get('priorGuest')==prior and isinstance(guest,dict)","and isinstance(guest,dict)",retained.Retained,'test_missing_phase_wrong_source_or_changed_chain_refuses'),
 ]
 for name,case,binding,file,old,new,cls,method in cases:
  source=(b/file).read_text();assert source.count(old)==1,(name,source.count(old));module=types.ModuleType('owned_tcp_mutant');module.__file__=str(b/file);exec(compile(source.replace(old,new,1),str(b/file),'exec'),module.__dict__);out=io.StringIO()
  with patch.object(case,binding,module):r=unittest.TextTestRunner(stream=out).run(unittest.TestSuite([cls(method)]))
  assert len(r.failures)==1 and not r.errors,(name,out.getvalue());results.append({'mutation':name,'assertionKilled':True})
 # The actual extracted initial block must refuse nonzero readback before Wi-Fi.
 kernel=load(b/'test_android_tcp_route.py','early_data_route_cases');source=(b/'emulator-tcp.py').read_text();old="if not proof['mobileDataZeroBeforeWifiRouting']:";assert source.count(old)==1
 with tempfile.TemporaryDirectory(prefix='obsync-early-data-') as tmp:
  root=Path(tmp);path=root/'emulator-tcp.py';path.write_text(source.replace(old,'if False:',1));out=io.StringIO()
  with patch.object(kernel,'T',types.SimpleNamespace(__file__=str(path),wait_phone_service=kernel.T.wait_phone_service)):r=unittest.TextTestRunner(stream=out).run(unittest.TestSuite([kernel.KernelRoute('test_actual_early_data_block_refuses_nonzero_or_failed_command_before_wifi')]))
 assert len(r.failures)==1 and not r.errors,out.getvalue();results.append({'mutation':'early-data-zero-before-wifi-required','assertionKilled':True})
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
 reboot=load(b/'test_android_tcp_reboot.py','reboot_mutation_cases')
 changes=[
  ('reboot-declaration',"if state.get('adbTransport')!='isolated-tcp' or state.get('rebootRequestMethod')!=REBOOT_REQUEST_METHOD:",'if False:','test_missing_method_foreign_guest_or_ownership_change_refuses_without_request'),
  ('reboot-guest-binding',"if original!=tcp or tcp!=state['selectedTcpAdb']['guest']:",'if False:','test_missing_method_foreign_guest_or_ownership_change_refuses_without_request'),
  ('reboot-request-target',"'-s',state['serial'],'reboot']","'-s',target,'reboot']",'test_actual_lifecycle_uses_one_declared_request_after_exact_transport_teardown'),
  ('reboot-request-deadline','   remaining(request_end);proof.update','   proof.update','test_error_timeout_late_request_and_late_save_never_retry_or_reattach'),
  ('reboot-save-deadline'," remaining(end)\n return proof\n",' return proof\n','test_helper_independently_refuses_late_final_save'),
  ('reboot-single-request','   result=subprocess.run(argv,env=env,stdout=subprocess.PIPE,stderr=subprocess.PIPE,check=True,timeout=max(.001,request_end-time.monotonic()))','   result=subprocess.run(argv,env=env,stdout=subprocess.PIPE,stderr=subprocess.PIPE,check=True,timeout=max(.001,request_end-time.monotonic()));result=subprocess.run(argv,env=env,stdout=subprocess.PIPE,stderr=subprocess.PIPE,check=True,timeout=max(.001,request_end-time.monotonic()))','test_actual_lifecycle_uses_one_declared_request_after_exact_transport_teardown'),
 ]
 for name,old,new,method in changes:
  source=(b/'emulator-tcp.py').read_text();assert source.count(old)==1,(name,source.count(old));module=types.ModuleType('reboot_mutant');module.__file__=str(b/'emulator-tcp.py');exec(compile(source.replace(old,new,1),module.__file__,'exec'),module.__dict__);out=io.StringIO()
  with patch.object(reboot,'T',module),patch.object(reboot.S,'TCP',module):r=unittest.TextTestRunner(stream=out).run(unittest.TestSuite([reboot.Reboot(method)]))
  assert len(r.failures)==1 and not r.errors,(name,out.getvalue());results.append({'mutation':name,'assertionKilled':True})
 for name,file,old,new,case,cls,method,binding in [
  ('reboot-tail-reverse-budget','android-session.py',"**({} if timeout is None else {'timeout':timeout})",'**{}',reboot,reboot.Reboot,'test_actual_tail_uses_only_remaining_phase_and_late_operation_or_save_refuses','S'),
  ('reboot-tail-final-deadline','android-session.py',"    if action=='reboot' and state.get('adbTransport')=='isolated-tcp':TCP.remaining(deadline)\n",'',reboot,reboot.Reboot,'test_actual_tail_uses_only_remaining_phase_and_late_operation_or_save_refuses','S'),
  ('reboot-new-boot','android-session.py',"if after!=before and ready=='1': break","if ready=='1': break",reboot,reboot.Reboot,'test_remaining_session_clips_request_and_unchanged_boot_cannot_pass','S'),
  ('reboot-required-retained-witness','mobile-acceptance.py',"    if mode=='full':\n        path=evidence/'owned-tcp-reboot-request.json'","    if False:\n        path=evidence/'owned-tcp-reboot-request.json'",retained,retained.Retained,'test_full_requires_exact_successful_reboot_request_witness_after_cleanup','M')]:
  source=(b/file).read_text();assert source.count(old)==1,name;module=types.ModuleType('reboot_caller_mutant');module.__file__=str(b/file);exec(compile(source.replace(old,new,1),module.__file__,'exec'),module.__dict__);out=io.StringIO()
  if binding=='S':module.TCP=reboot.T
  with patch.object(case,binding,module):r=unittest.TextTestRunner(stream=out).run(unittest.TestSuite([cls(method)]))
  assert len(r.failures)==1 and not r.errors,(name,out.getvalue());results.append({'mutation':name,'assertionKilled':True})
 results.extend(observation_mutations(b));results.extend(wifi_restore_mutations(b));results.extend(incoming_reboot_mutations(b))
 print(json.dumps({'result':'PASS','count':len(results),'mutations':results}));return 0

if __name__=='__main__':raise SystemExit(main())
