"""Fixed synthetic fixture restoration; actual helper and initial gate, no native I/O."""
import ast,copy,importlib.util,json,subprocess,unittest
from pathlib import Path
from unittest.mock import patch
P=Path(__file__).parent
sp=importlib.util.spec_from_file_location('restore_session',P/'android-session.py');S=importlib.util.module_from_spec(sp);sp.loader.exec_module(S);T=S.TCP
PRIOR={'bootIdSha256':'a'*64,'adbdPid':100,'adbdStartTicks':'1'}
def fixture():return {'serial':'emulator-5584','sourceHead':'a'*40,'rebootWifiRestoration':{'method':T.WIFI_RESTORATION_METHOD,'sourceHead':'a'*40,'initialBootIdSha256':'a'*64,'initialKnownNetworkConnected':True}}
class Restore(unittest.TestCase):
 def test_initial_gate_requires_exact_one_enabled_synthetic_network(self):
  tree=ast.parse((P/'emulator-tcp.py').read_text());fn=next(n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name=='initial');body=next(n for n in fn.body if isinstance(n,ast.Try)).body
  index=next(i for i,n in enumerate(body) if isinstance(n,ast.Assign) and ast.unparse(n.targets[0])=="proof['initialSyntheticWifi']")
  for text,accepted in [('Wifi is enabled\nWifi is connected to "AndroidWifi"',True),('Wifi is enabled\nWifi is connected to "PRIVATE_FOREIGN"',False),('Wifi is disabled',False),('Wifi is enabled\nWifi is connected to "AndroidWifi"\nWifi is connected to "AndroidWifi"',False)]:
   scope={'proof':{},'state':{'sourceHead':'a'*40},'after':PRIOR,'target':'127.0.0.1:12346','observe':lambda *a:text,'known_synthetic_wifi':T.known_synthetic_wifi,'WIFI_RESTORATION_METHOD':T.WIFI_RESTORATION_METHOD}
   error=None
   try:exec(compile(ast.fix_missing_locations(ast.Module(body=body[index:index+3],type_ignores=[])),'actual-initial-network-gate','exec'),scope)
   except ValueError as e:error=e
   self.assertEqual(error is None,accepted);self.assertEqual('rebootWifiRestoration' in scope['state'],accepted);self.assertNotIn('PRIVATE_FOREIGN',json.dumps(scope['proof']))
 def test_locked_wait_then_unlocked_issues_one_original_request_across_attempts(self):
  context={};facts={};values=iter(['RUNNING_UNLOCKING','RUNNING_UNLOCKED',''])
  with patch.object(T,'command',side_effect=lambda *a,**k:next(values) if a[3][-1]=='0' else '') as command,patch.object(T,'remaining',return_value=1):
   self.assertFalse(T.restore_known_wifi_once(fixture(),{},240,PRIOR,context,facts,S.APK.apk_command_failure))
   self.assertTrue(T.restore_known_wifi_once(fixture(),{},240,PRIOR,context,facts,S.APK.apk_command_failure))
   self.assertTrue(T.restore_known_wifi_once(fixture(),{},240,PRIOR,context,facts,S.APK.apk_command_failure))
  self.assertEqual(command.call_count,3);request=command.call_args_list[-1];self.assertEqual(list(request.args[2:]),[fixture()['serial'],['shell','cmd','wifi','connect-network','AndroidWifi','open'],240]);self.assertEqual(request.kwargs,{'cap':30});self.assertEqual(context['restoration']['requestCount'],1);self.assertFalse(context['restoration']['connectionEstablishedByResponse'])
 def test_prior_unlock_observation_is_immutable_after_later_request(self):
  context={};first={};last={};values=iter(['RUNNING_UNLOCKING','RUNNING_UNLOCKED',''])
  with patch.object(T,'command',side_effect=lambda *a,**k:next(values) if a[3][-1]=='0' else ''),patch.object(T,'remaining',return_value=1):
   self.assertFalse(T.restore_known_wifi_once(fixture(),{},240,PRIOR,context,first,S.APK.apk_command_failure))
   self.assertTrue(T.restore_known_wifi_once(fixture(),{},240,PRIOR,context,last,S.APK.apk_command_failure))
  self.assertEqual(first['wifiRestoration']['requestCount'],0);self.assertEqual(first['wifiRestoration']['userState'],'RUNNING_UNLOCKING');self.assertEqual(first['wifiRestoration']['result'],'WAITING_FOR_USER_UNLOCK');self.assertEqual(last['wifiRestoration']['requestCount'],1);self.assertEqual(last['wifiRestoration']['userState'],'RUNNING_UNLOCKED')
 def test_failure_timeout_refusal_or_late_result_is_terminal_without_second_request(self):
  for failure in ('timeout','failed','refused','late'):
   context={};facts={};calls=[]
   def command(st,env,target,args,end,**kw):
    calls.append(args)
    if args[-1]=='0':return 'RUNNING_UNLOCKED'
    if failure=='timeout':raise subprocess.TimeoutExpired('fixed',30,stderr=b'PRIVATE_SENTINEL')
    if failure=='failed':raise subprocess.CalledProcessError(1,'fixed',stderr=b'device offline PRIVATE_SENTINEL')
    return 'Connection failed' if failure=='refused' else ''
   with patch.object(T,'command',side_effect=command),patch.object(T,'remaining',side_effect=TimeoutError('late') if failure=='late' else lambda *a:1):
    with self.assertRaises(ValueError) as caught:T.restore_known_wifi_once(fixture(),{},240,PRIOR,context,facts,S.APK.apk_command_failure)
    self.assertNotIsInstance(caught.exception,(OSError,subprocess.SubprocessError))
    with self.assertRaises(ValueError):T.restore_known_wifi_once(fixture(),{},240,PRIOR,context,facts,S.APK.apk_command_failure)
   self.assertEqual(len(calls),2);self.assertEqual(context['restoration']['requestCount'],1);self.assertEqual(context['restoration']['result'],'FAILED');self.assertNotIn('PRIVATE_SENTINEL',json.dumps(context))
 def test_missing_foreign_or_wrong_boot_declaration_refuses_before_input(self):
  for change in ({},{'sourceHead':'b'*40},{'initialBootIdSha256':'b'*64},{'method':'OTHER'}):
   state=fixture();state['rebootWifiRestoration']=change if not change else {**state['rebootWifiRestoration'],**change}
   with patch.object(T,'command') as command,self.assertRaises(ValueError):T.restore_known_wifi_once(state,{},240,PRIOR,{}, {},S.APK.apk_command_failure)
   command.assert_not_called()
 def test_actual_command_caps_only_literal_owned_framework_request_and_checks_lateness(self):
  state={'serial':'emulator-5584','sdk':'/owned/sdk','adbPort':12345,'ownedWifiTcpSetup':{'hostPort':12346}};args=['shell','cmd','wifi','connect-network','AndroidWifi','open'];clock=[100.]
  with patch.object(T.time,'monotonic',side_effect=lambda:clock[0]),patch.object(T.subprocess,'check_output',return_value='') as command:
   self.assertEqual(T.command(state,{},state['serial'],args,115,cap=30),'');self.assertEqual(command.call_args.kwargs['timeout'],15)
   for target,argv in [('127.0.0.1:12346',args),(state['serial'],args[:-2]+['FOREIGN','open'])]:
    with self.assertRaises(ValueError):T.command(state,{},target,argv,115,cap=30)
   self.assertEqual(command.call_count,1)
  def late(*a,**k):clock[0]=116;return ''
  with patch.object(T.time,'monotonic',side_effect=lambda:clock[0]),patch.object(T.subprocess,'check_output',side_effect=late),self.assertRaises(TimeoutError):T.command(state,{},state['serial'],args,115,cap=30)
 def test_root_still_requires_original_response_route_before_connect(self):
  state=fixture();state['processes']={'emulator':{'pid':777,'identity':'owned qemu'}};state['selectedTcpAdb']={'hostPort':12346,'guest':PRIOR};events=[]
  def route(*a,**k):events.append('root-route');raise TimeoutError('root route missing')
  with patch.object(T,'selected',return_value='127.0.0.1:12346'),patch.object(T,'listener'),patch.object(T,'guest',return_value=PRIOR),patch.object(T,'response_route_ready',side_effect=route),patch.object(T,'connect') as connect,patch.object(T,'incoming_guest') as incoming:
   with self.assertRaises(TimeoutError):T.reattach(state,P,{},240,'root',lambda *a:None)
  self.assertEqual(events,['root-route']);connect.assert_not_called();incoming.assert_not_called()
class Ready(unittest.TestCase):
 def exercise(self,ready_at=2,broken=None,end=1):
  state=fixture();state['processes']={'emulator':{'pid':777,'identity':'owned qemu'}};state['selectedTcpAdb']={'hostPort':12346,'guest':PRIOR};state['ownedWifiTcpSetup']={'hostPort':12346,'radioOptions':'restrict=on','wifiOptions':'restrict=on,dhcpstart=10.0.2.16,hostfwd=tcp:127.0.0.1:12346-10.0.2.16:5555'}
  original=PRIOR|{'bootIdSha256':'b'*64,'adbdPid':201};clock=[0.];polls=[0];calls=[];saved=[];observed=[];error=None
  frame={'guest':original,'adbdUid':2000,'stdoutBytes':200,'stdoutSha256':'c'*64,'framing':'COMPLETE_GUEST_AND_BOUND_UID'}
  def incoming(st,env,target,deadline):
   if target==state['serial']:return frame|({'guest':PRIOR} if broken=='guest' else {})
   self.assertTrue(any(args[0]=='connect' for _,args in calls));return frame
  def command(st,env,target,args,deadline,**kwargs):
   self.assertEqual(deadline,end);calls.append((target,args))
   if args==['shell','getprop','sys.boot_completed']:return '1'
   if args[0]=='connect':return 'failed to connect to 127.0.0.1:12346' if broken=='connect' else 'connected to 127.0.0.1:12346'
   self.assertEqual(target,state['serial']);self.assertEqual(kwargs,{'binary':True})
   if args==['shell','cmd','wifi','status']:
    polls[0]+=1
    if broken=='read':raise subprocess.TimeoutExpired('fixed',3,stderr=b'PRIVATE_SENTINEL')
    if broken=='late':clock[0]=end+.1
    if broken=='unknown':return b'PRIVATE_SENTINEL'
    return b'Wifi is enabled\n'+(b'Wifi is connected to "AndroidWifi"\n' if ready_at and polls[0]>=ready_at else b'')
   self.assertEqual(args,['shell','ip','-o','-4','addr','show','dev','wlan0'])
   if broken=='address':return b'PRIVATE_SENTINEL'
   return b'5: wlan0 inet 10.0.2.16/24 scope global wlan0\n' if ready_at and polls[0]>=ready_at else b''
  with patch.object(T,'selected',return_value='127.0.0.1:12346'),patch.object(T,'listener',return_value={'pid':777}),patch.object(T,'guest',return_value=original),patch.object(T,'restore_known_wifi_once',return_value=True),patch.object(T,'incoming_guest',side_effect=incoming),patch.object(T,'command',side_effect=command),patch.object(T.time,'monotonic',side_effect=lambda:clock[0]),patch.object(T.time,'sleep',side_effect=lambda value:clock.__setitem__(0,clock[0]+value)):
   try:T.reattach(state,P,{},end,'reboot',lambda p,v:saved.append(copy.deepcopy(v)),observed.append,S.APK.apk_command_failure,{})
   except Exception as caught:error=caught
  return calls,saved,observed,error,clock[0],polls[0]
 def test_deferred_association_and_ipv4_precede_only_connect_with_bound_witness(self):
  calls,saved,observed,error,clock,polls=self.exercise();self.assertIsNone(error);self.assertEqual(polls,2);self.assertEqual(sum(args[0]=='connect' for _,args in calls),1)
  p=saved[-1]['responseRouteProof'];r=p['wifiReadiness'];self.assertFalse(r['first']['ready']);self.assertTrue(r['last']['ready']);self.assertEqual(r['polls'],2);self.assertLessEqual(r['last']['observedAtMonotonicMs'],r['finishedAtMonotonicMs']);self.assertLessEqual(r['finishedAtMonotonicMs'],p['connectStartedAtMonotonicMs']);self.assertLess(p['connectStartedAtMonotonicMs'],r['phaseDeadlineMonotonicMs']);self.assertEqual(observed[-1]['connectResponseClass'],'CONNECTED')
 def test_never_ready_unknown_wrong_guest_failed_or_late_reads_cannot_connect(self):
  for ready,broken,end in [(None,None,.5),(1,'guest',1),(1,'unknown',1),(1,'address',1),(1,'read',1),(1,'late',1)]:
   calls,saved,observed,error,clock,polls=self.exercise(ready,broken,end);self.assertIsInstance(error,ValueError);self.assertEqual(saved,[]);self.assertFalse(any(args[0]=='connect' for _,args in calls));self.assertEqual(observed[-1]['stage'],'reboot_wifi_readiness');self.assertNotIn('PRIVATE_SENTINEL',json.dumps(observed))
   if ready is None:self.assertEqual(clock,end)
   if broken in ('read','unknown'):self.assertEqual(polls,1)
 def test_failed_connect_class_is_retained_before_any_selected_frame(self):
  calls,saved,observed,error,clock,polls=self.exercise(1,'connect');self.assertIsInstance(error,T.ExpectedAttachmentPending);self.assertEqual(saved,[]);self.assertEqual(observed[-1]['connectResponseClass'],'FAILED_GENERIC');self.assertEqual(sum(args[0]=='connect' for _,args in calls),1)

if __name__=='__main__':unittest.main()
