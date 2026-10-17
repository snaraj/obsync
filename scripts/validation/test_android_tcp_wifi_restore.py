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
  state=fixture();state['selectedTcpAdb']={'hostPort':12346,'guest':PRIOR};events=[]
  def route(*a,**k):events.append('root-route');raise TimeoutError('root route missing')
  with patch.object(T,'selected',return_value='127.0.0.1:12346'),patch.object(T,'listener'),patch.object(T,'guest',return_value=PRIOR),patch.object(T,'response_route_ready',side_effect=route),patch.object(T,'connect') as connect,patch.object(T,'incoming_guest') as incoming:
   with self.assertRaises(TimeoutError):T.reattach(state,P,{},240,'root',lambda *a:None)
  self.assertEqual(events,['root-route']);connect.assert_not_called();incoming.assert_not_called()
if __name__=='__main__':unittest.main()
