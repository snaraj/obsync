"""Actual controller/helper reboot path. No process, device or socket is opened."""
import ast,copy,importlib.util,subprocess,unittest
from contextlib import ExitStack
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
B=Path(__file__).parent
spec=importlib.util.spec_from_file_location('reboot_controller',B/'android-session.py');S=importlib.util.module_from_spec(spec);spec.loader.exec_module(S);T=S.TCP
FACT={'bootIdSha256':'a'*64,'adbdPid':101,'adbdStartTicks':'20'}
def fixture():
 state={'sourceHead':'a'*40,'serial':'emulator-5584','sdk':'/owned/sdk','adbPort':12345,'expiresAtEpoch':1300,'adbTransport':'isolated-tcp','rebootRequestMethod':T.REBOOT_REQUEST_METHOD,'processes':{'emulator':{'pid':777,'identity':'owned qemu'}},'reversePorts':[]}
 T.save_binding(state,Path('/unused'),12346,FACT,'initial',lambda *a:None,FACT);return state

def scenario(kind='success',state=None,helper_only=False):
 state=fixture() if state is None else state;clock=[0.];events=[];saved=[];request_calls=[];guest_calls=[];ownership=[0];tail_calls=[];reverse_calls=[0]
 def guest(*args):
  guest_calls.append(args[2]);events.append(('guest',args[2]));return {**FACT,'adbdPid':102} if kind=='wrong-guest' and len(guest_calls)==2 else FACT
 def host(st,env,target,args,end,**kw):
  events.append(tuple(args));return 'disconnected '+state['selectedTcpAdb']['target'] if args[0]=='disconnect' else 'unexpected' if kind=='bad-removal-response' else ''
 def owned(_run):
  ownership[0]+=1
  if kind=='ownership-after-disconnect' and ownership[0]>=3:raise ValueError('owned process changed')
  return state
 def command(st,args,**kwargs):
  events.append(('selected',*args))
  if args[0]=='reverse':tail_calls.append(('adb',kwargs))
  if args[-1]=='/proc/sys/kernel/random/boot_id':return 'old' if events.count(('selected',*args))==1 or kind=='unchanged-boot' else 'new'
  return '1' if args[-1]=='sys.boot_completed' else ''
 def request(argv,**kwargs):
  request_calls.append((argv,kwargs));events.append(('request',argv[4]))
  if kind=='request-timeout':raise subprocess.TimeoutExpired(argv,kwargs['timeout'],output=b'',stderr=b'')
  if kind=='request-error':raise subprocess.CalledProcessError(1,argv,output=b'',stderr=b'PRIVATE_ERROR')
  if kind=='late-request':clock[0]=30.001
  if kind=='near-expiry':clock[0]=.1
  return SimpleNamespace(returncode=0,stdout=b'',stderr=b'')
 def save(path,value):
  saved.append((path,copy.deepcopy(value)))
  if kind=='late-save' and path.name=='owned-tcp-reboot-request.json':clock[0]=241
  if kind=='late-tail-save' and path.name.startswith('android-reboot-'):clock[0]=241
 def ready(*args):
  events.append(('reattach',))
  if kind in ('tail-budget','late-tail-operation','late-tail-save'):clock[0]=239.9
  return True
 def pid(*args,**kwargs):tail_calls.append(('pid',kwargs));return None
 def reverse(*args,**kwargs):
  reverse_calls[0]+=1
  if reverse_calls[0]>1:
   tail_calls.append(('reverse-check',kwargs))
   if kind=='late-tail-operation':clock[0]=241
 def pause(value):clock[0]+=value
 with ExitStack() as stack:
  for target,name,value in [(S,'live_state',owned),(S,'check_reverse',reverse),(S,'adb_env',lambda *a:{}),(S,'stopped_app',lambda *a,**k:222),(S,'adb_command',command),(S,'app_pid',pid),(S,'register_emulator',lambda *a:None),(S,'reattach_tcp',ready),(S,'save',save),(T,'guest',guest),(T,'listener',lambda *a:events.append(('listener',))),(T,'command',host),(T.subprocess,'run',request),(T.time,'monotonic',lambda:clock[0]),(T.time,'time',lambda:1000),(T.time,'sleep',pause)]:stack.enter_context(patch.object(target,name,side_effect=value))
  error=None;result=None
  try:result=T.request_reboot(state,Path('/owned'),{},240,save,lambda:owned(Path('/owned'))) if helper_only else S.lifecycle(Path('/owned'),'reboot',240)
  except Exception as caught:error=caught
 return SimpleNamespace(state=state,error=error,result=result,saved=saved,events=events,requests=request_calls,guests=guest_calls,ownership=ownership[0],tail_calls=tail_calls)

class Reboot(unittest.TestCase):
 def test_actual_state_producer_predeclares_only_isolated_method(self):
  tree=ast.parse((B/'android-session.py').read_text());fn=next(n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name=='execute');node=next(n for n in fn.body if isinstance(n,ast.Assign) and any(isinstance(t,ast.Name) and t.id=='state' for t in n.targets));a=SimpleNamespace(run=Path('/owned'),source_head='a'*40,sdk=Path('/sdk'),port=5584,adb_transport='isolated-tcp',seconds=100,reverse=[],java=Path('/java'))
  for isolated in (False,True):
   scope={'a':a,'started':0,'adb_port':12345,'controller_identity':'owned','os':SimpleNamespace(getpid=lambda:100),'TCP':T,'isolated':isolated};exec(compile(ast.fix_missing_locations(ast.Module(body=[node],type_ignores=[])),'actual-state-producer','exec'),scope)
   self.assertEqual(scope['state'].get('rebootRequestMethod'),T.REBOOT_REQUEST_METHOD if isolated else None)
 def test_actual_lifecycle_uses_one_declared_request_after_exact_transport_teardown(self):
  r=scenario();self.assertIsNone(r.error);self.assertEqual(r.result['result'],'REBOOTED');self.assertNotEqual(r.result['oldBootId'],r.result['newBootId']);self.assertEqual(len(r.requests),1);self.assertEqual(r.requests[0][0],['/owned/sdk/platform-tools/adb','-P','12345','-s','emulator-5584','reboot']);self.assertEqual(r.requests[0][1]['timeout'],30)
  self.assertEqual(r.events.count(('disconnect','127.0.0.1:12346')),1);self.assertEqual(r.events.count(('wait-for-disconnect',)),1);self.assertEqual(r.guests,['emulator-5584','127.0.0.1:12346','emulator-5584']);self.assertLess(r.events.index(('disconnect','127.0.0.1:12346')),r.events.index(('wait-for-disconnect',)));self.assertLess(r.events.index(('wait-for-disconnect',)),r.events.index(('request','emulator-5584')));self.assertLess(r.events.index(('request','emulator-5584')),r.events.index(('reattach',)));self.assertGreaterEqual(r.ownership,4)
  proof=next(v for p,v in r.saved if p.name=='owned-tcp-reboot-request.json');self.assertEqual(proof['result'],'PASS');self.assertEqual(proof['requestCount'],1);self.assertEqual(proof['disconnectCount'],1);self.assertTrue(proof['selectedTransportRemoved']);self.assertEqual(r.result['rebootRequestMethod'],T.REBOOT_REQUEST_METHOD)
 def test_missing_method_foreign_guest_or_ownership_change_refuses_without_request(self):
  s=fixture();del s['rebootRequestMethod']
  for kind,state in [('success',s),('wrong-guest',None),('ownership-after-disconnect',None),('bad-removal-response',None)]:
   r=scenario(kind,state);self.assertIsInstance(r.error,ValueError);self.assertEqual(r.requests,[]);self.assertNotIn(('reattach',),r.events);proof=next(v for p,v in r.saved if p.name=='owned-tcp-reboot-request.json');self.assertEqual(proof['result'],'FAIL');self.assertEqual(proof['requestCount'],0)
 def test_error_timeout_late_request_and_late_save_never_retry_or_reattach(self):
  for kind in ('request-error','request-timeout','late-request','late-save'):
   r=scenario(kind);self.assertIsNotNone(r.error,kind);self.assertEqual(len(r.requests),1);self.assertNotIn(('reattach',),r.events);self.assertEqual(sum(e==('disconnect','127.0.0.1:12346') for e in r.events),1)
   proof=next(v for p,v in r.saved if p.name=='owned-tcp-reboot-request.json');self.assertEqual(proof['sourceHead'],'a'*40);self.assertNotIn('PRIVATE_ERROR',str(proof))
   if kind!='late-save':self.assertEqual(proof['result'],'FAIL');self.assertEqual(proof['failure']['stage'],'original_emulator_reboot_request')
 def test_helper_independently_refuses_late_final_save(self):
  r=scenario('late-save',helper_only=True);self.assertIsInstance(r.error,TimeoutError);self.assertEqual(len(r.requests),1);self.assertIsNone(r.result)
 def test_remaining_session_clips_request_and_unchanged_boot_cannot_pass(self):
  s=fixture();s['expiresAtEpoch']=1000.25;r=scenario('near-expiry',s);self.assertIsNone(r.error);self.assertEqual(r.requests[0][1]['timeout'],.25)
  r=scenario('unchanged-boot');self.assertIsInstance(r.error,TimeoutError);self.assertEqual(len(r.requests),1);self.assertIsNone(r.result)
 def test_legacy_request_and_usb_refusal_are_unchanged(self):
  s=fixture();s.pop('adbTransport');s.pop('selectedTcpAdb');s.pop('rebootRequestMethod');r=scenario(state=s)
  self.assertIsNone(r.error);self.assertEqual(r.requests,[]);self.assertIn(('selected','reboot'),r.events)
  with patch.object(S,'live_state',return_value={'targetKind':'usb'}),patch.object(S,'check_reverse') as reverse,self.assertRaisesRegex(ValueError,'physical device'):S.lifecycle(Path('/owned'),'reboot')
  reverse.assert_not_called()
 def test_actual_tail_uses_only_remaining_phase_and_late_operation_or_save_refuses(self):
  s=fixture();s['reversePorts']=[18474];r=scenario('tail-budget',s);self.assertIsNone(r.error);self.assertEqual([name for name,_ in r.tail_calls],['pid','adb','adb','reverse-check'])
  self.assertTrue(all(0<values['timeout']<=.100001 for _,values in r.tail_calls))
  for kind in ('late-tail-operation','late-tail-save'):
   r=scenario(kind);self.assertIsInstance(r.error,TimeoutError,kind);self.assertIsNone(r.result);self.assertEqual(len(r.requests),1)
  s=fixture();s.pop('adbTransport');s.pop('selectedTcpAdb');s.pop('rebootRequestMethod');r=scenario(state=s);self.assertIsNone(r.error);self.assertTrue(all(values=={} for _,values in r.tail_calls))
  for options in ({},{'timeout':.1}):
   with patch.object(S,'adb_command',return_value='tcp:18474 tcp:18474') as read:S.check_reverse({'reversePorts':[18474]},**options)
   self.assertEqual(read.call_args.kwargs,options)
 def test_preparation_budget_clips_each_actual_stop_command_and_late_absence_refuses(self):
  clock=[0];calls=[]
  def command(state,args,timeout):calls.append(timeout);clock[0]=.6
  def pid(*args,**kwargs):calls.append(kwargs['timeout']);return 222 if len(calls)==1 else None
  with patch.object(S.time,'monotonic',side_effect=lambda:clock[0]),patch.object(S,'app_pid',side_effect=pid),patch.object(S,'adb_command',side_effect=command),patch.object(S,'devtools_present',return_value=False):self.assertEqual(S.stopped_app({},end=1),222)
  self.assertEqual(calls,[1,1,.4])
  def late(*args,**kwargs):clock[0]=1.1;return None
  clock[0]=0
  with patch.object(S.time,'monotonic',side_effect=lambda:clock[0]),patch.object(S,'app_pid',side_effect=late),patch.object(S,'adb_command') as adb,self.assertRaises(TimeoutError):S.stopped_app({},end=1)
  adb.assert_not_called()
if __name__=='__main__':unittest.main()
