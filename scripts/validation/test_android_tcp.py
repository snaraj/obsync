import copy,importlib.util,json,os,subprocess,tempfile,time,unittest
from pathlib import Path
from unittest.mock import patch
B=Path(__file__).parent
spec=importlib.util.spec_from_file_location('tcp_control',B/'emulator-tcp.py');T=importlib.util.module_from_spec(spec);spec.loader.exec_module(T)
spec=importlib.util.spec_from_file_location('session_control',B/'android-session.py');S=importlib.util.module_from_spec(spec);spec.loader.exec_module(S)
FACT={'bootIdSha256':'a'*64,'adbdPid':101,'adbdStartTicks':'1234'}
def state(run):return {'adbTransport':'isolated-tcp','serial':'emulator-5584','sdk':'/owned/sdk','adbPort':12345,'expiresAtEpoch':time.time()+100,'sourceHead':'a'*40,'processes':{'emulator':{'pid':777,'identity':'owned qemu'}},'environment':{'HOME':str(run/'runtime/user'),'ANDROID_EMULATOR_HOME':str(run/'runtime/user')}}
def bind(s):
 T.save_binding(s,Path('/unused'),12346,FACT,'initial',lambda *a:None,FACT)
 s['rebootWifiRestoration']={'method':T.WIFI_RESTORATION_METHOD,'sourceHead':s['sourceHead'],'initialBootIdSha256':FACT['bootIdSha256'],'initialKnownNetworkConnected':True}
def lifecycle_command(values):
 values=iter(values)
 def call(st,env,target,args,end,**kw):
  return 'RUNNING_UNLOCKED' if args==['shell','am','get-started-user-state','0'] else '' if args==['shell','cmd','wifi','connect-network','AndroidWifi','open'] else next(values)
 return call

class Route(unittest.TestCase):
 def setUp(self):
  def routed(*args,**kwargs):
   proof=args[5];proof.update(adbdUid=0,guestResponseRouteReadiness={'ready':True,'last':{'ready':True,'state':'WLAN0_ROUTE','uid':0}})
  self.route_patch=patch.object(T,'response_route_ready',side_effect=routed);self.route_patch.start();self.addCleanup(self.route_patch.stop)
 def test_initial_uses_verified_wifi_backend_and_one_standard_connect_with_independent_routes(self):
  with tempfile.TemporaryDirectory() as d:
   run=Path(d).resolve();(run/'private').mkdir();s=state(run);calls=[];saved=[]
   class Socket:
    def __enter__(self):return self
    def __exit__(self,*a):pass
    def bind(self,address):pass
    def getsockname(self):return ('127.0.0.1',12346)
   with patch.object(T.socket,'socket',return_value=Socket()):argv=T.prepare(s)
   self.assertEqual(argv,['-feature','-WiFiPacketStream','-network-user-mode-options','restrict=on','-wifi-user-mode-options','restrict=on,dhcpstart=10.0.2.16,hostfwd=tcp:127.0.0.1:12346-10.0.2.16:5555'])
   (run/'private/emulator.log').write_text('argv[01] = "user,id=mynet,restrict=on"\nargv[02] = "user,id=virtio-wifi,'+s['ownedWifiTcpSetup']['wifiOptions']+'"\n')
   def cmd(st,env,target,args,end,cap=3):
    calls.append((target,args,cap));return 'Wifi is enabled\nWifi is connected to \"AndroidWifi\"' if args==['shell','cmd','wifi','status'] else '5: wlan0    inet 10.0.2.16/24 brd 10.0.2.255 scope global wlan0' if args==['shell','ip','-o','-4','addr','show'] else 'connected to 127.0.0.1:12346' if args==['connect','127.0.0.1:12346'] else '3: dummy0: <UP>\n    dummy addrgenmode eui64\n' if args==['shell','/system/xbin/su','0','/system/bin/ip','-d','link','show','dev','dummy0'] else '0' if args==['shell','settings','get','global','mobile_data'] else 'default dev dummy0 table 1003 proto static scope link\n' if args==['shell','ip','-4','route','show','table','all'] else ''
   with patch.object(T,'guest',side_effect=[FACT,FACT]) as guest,patch.object(T,'command',side_effect=cmd),patch.object(T,'listener',return_value={'pid':777}):T.initial(s,run,{},time.monotonic()+10,lambda p,v:saved.append((p,v)))
   self.assertEqual([c.args[2] for c in guest.call_args_list],['emulator-5584','127.0.0.1:12346']);self.assertEqual(s['serial'],'emulator-5584');self.assertEqual(T.selected(s),'127.0.0.1:12346')
   self.assertEqual(calls[0],('emulator-5584',['shell','svc','wifi','enable'],30));self.assertEqual([c for c in calls if c[1][:1]==['connect']],[(None,['connect','127.0.0.1:12346'],12)])
   provision=[c for c in calls if c[1] in (['shell','settings','put','global','mobile_data','0'],['shell','svc','data','disable'])];self.assertEqual(provision,[('127.0.0.1:12346',['shell','settings','put','global','mobile_data','0'],30),('127.0.0.1:12346',['shell','svc','data','disable'],30)]);self.assertLess(calls.index((None,['connect','127.0.0.1:12346'],12)),calls.index(provision[0]));self.assertTrue(saved[-1][1]['mobileDataGlobalSettingZero']);self.assertEqual(saved[-1][1]['ipv4RouteIsolation']['verifiedDiscardRoutes'],1)
   self.assertFalse(any('redir' in c[1] or c[1][-1:] == ['disable'] and 'wifi' in c[1] for c in calls));self.assertEqual(saved[-1][1]['result'],'OBSERVED');self.assertEqual(next(x['commandCapMs'] for x in saved[-1][1]['commands'] if x['stage']=='single_standard_tcp_connect'),12000);self.assertEqual(next(x['commandCapMs'] for x in saved[-1][1]['commands'] if x['stage']=='enable_only_owned_guest_wifi_once'),30000)
   s.pop('selectedTcpAdb');calls.clear();saved.clear()
   for which in ('data','route'):
    def wrong(st,env,target,args,end,cap=3):
     value=cmd(st,env,target,args,end,cap)
     if which=='data' and args==['shell','settings','get','global','mobile_data']:return '1'
     if which=='route' and args==['shell','ip','-4','route','show','table','all']:return 'default via 10.0.2.2 dev eth0'
     return value
    with patch.object(T,'guest',side_effect=[FACT,FACT]),patch.object(T,'command',side_effect=wrong),patch.object(T,'listener',return_value={'pid':777}),self.assertRaisesRegex(ValueError,'unexpected data or egress'):T.initial(s,run,{},time.monotonic()+10,lambda p,v:saved.append((p,v)))
    self.assertNotIn('selectedTcpAdb',s);self.assertEqual(saved[-1][1]['result'],'FAIL')
   with patch.object(T,'guest',side_effect=[FACT,{**FACT,'adbdPid':102}]),patch.object(T,'command',side_effect=cmd),patch.object(T,'listener',return_value={'pid':777}),self.assertRaisesRegex(ValueError,'guest differs'):T.initial(s,run,{},time.monotonic()+10,lambda p,v:saved.append((p,v)))
   self.assertNotIn('selectedTcpAdb',s)
   error=subprocess.CalledProcessError(1,[],output=b'',stderr=b'RTNETLINK answers: Permission denied\nPRIVATE_VALUE')
   def denied(st,env,target,args,end,cap=3):
    if args==['shell','/system/xbin/su','0','/system/bin/ip','-d','link','show','dev','dummy0']:raise error
    return cmd(st,env,target,args,end,cap)
   with patch.object(T,'guest',side_effect=[FACT,FACT]),patch.object(T,'command',side_effect=denied),patch.object(T,'listener',return_value={'pid':777}),self.assertRaises(subprocess.CalledProcessError):T.initial(s,run,{},time.monotonic()+10,lambda p,v:saved.append((p,v)),S.APK.apk_command_failure)
   self.assertEqual(saved[-1][1]['failure']['commandFailure']['errorClass'],'permission_denied');self.assertEqual(saved[-1][1]['failure']['commandFailure']['stderrBytes'],len(error.stderr));self.assertNotIn('PRIVATE_VALUE',json.dumps(saved[-1][1]));self.assertNotIn('Permission denied',json.dumps(saved[-1][1]))
   self.assertNotIn('selectedTcpAdb',s)
   calls.clear();saved.clear()
   (run/'private/emulator.log').write_text('argv[01] = "user,id=mynet"\n')
   with patch.object(T,'command',side_effect=cmd),self.assertRaisesRegex(ValueError,'effective restricted'):T.initial(s,run,{},time.monotonic()+10,lambda p,v:saved.append((p,v)))
   self.assertEqual(calls,[]);self.assertNotIn('selectedTcpAdb',s)
 def test_guest_parser_uses_one_framed_read_and_refuses_incomplete_or_wrong_identity(self):
  boot='12345678-1234-1234-1234-123456789abc';stat='101 (adbd) '+' '.join(['S']+['0']*18+['1234']);raw=boot+'\n101\n'+stat+'\nOBSYNC_GUEST_IDENTITY_COMPLETE\n'
  with patch.object(T,'command',return_value=raw) as c:proof=T.guest({}, {},'127.0.0.1:12346',time.monotonic()+10)
  self.assertEqual(proof['adbdPid'],101);self.assertEqual(proof['adbdStartTicks'],'1234');self.assertEqual(c.call_count,1);self.assertEqual(c.call_args.args[3][:3],['shell','sh','-c'])
  for broken in (raw.replace('OBSYNC_GUEST_IDENTITY_COMPLETE',''),raw.replace('101 (adbd)','102 (adbd)'),raw.replace('\n101\n','\n101 102\n')):
   with patch.object(T,'command',return_value=broken),self.assertRaises(ValueError):T.guest({}, {},'127.0.0.1:12346',time.monotonic()+10)
 def test_listener_requires_exact_qemu_ipv4_loopback_and_single_owner(self):
  s=state(Path('/owned'))
  for text,valid in [(b'p777\nf99\nn127.0.0.1:12346\n',True),('p778\nn127.0.0.1:12346\n',False),('p777\nn*:12346\n',False),('p777\nn[::1]:12346\n',False),('p777\nn127.0.0.1:12346\np778\nn127.0.0.1:12346\n',False)]:
   with patch.object(T.subprocess,'run',return_value=type('R',(),{'stdout':text.encode() if isinstance(text,str) else text,'stderr':b'','returncode':0})()):
    if valid:self.assertEqual(T.listener(s,12346,time.monotonic()+10)['pid'],777)
    else:
     with self.assertRaises(ValueError):T.listener(s,12346,time.monotonic()+10)
 def test_ready_binding_missing_or_foreign_never_falls_back(self):
  s=state(Path('/owned'))
  with self.assertRaises(ValueError):T.selected(s)
  bind(s);self.assertEqual(T.selected(s),'127.0.0.1:12346')
  for key,val in [('target','emulator-5584'),('emulatorPid',778),('emulatorIdentity','foreign'),('guestPort',5556),('hostPort',True),('guest',{})]:
   wrong=copy.deepcopy(s);wrong['selectedTcpAdb'][key]=val
   with self.assertRaises(ValueError):T.selected(wrong)
 def test_actual_session_command_uses_selected_target_and_failed_read_once(self):
  s=state(Path('/owned'));bind(s)
  with patch.object(S.subprocess,'check_output',return_value=b'bytes') as c:self.assertEqual(S.adb_command(s,['exec-out','cat','/owned/synthetic/main.js'],binary=True),b'bytes')
  self.assertEqual(c.call_args.args[0][:5],['/owned/sdk/platform-tools/adb','-P','12345','-s','127.0.0.1:12346'])
  with patch.object(S.subprocess,'check_output',side_effect=subprocess.CalledProcessError(1,[])) as c,self.assertRaises(subprocess.CalledProcessError):S.adb_command(s,['pull','/owned/synthetic.apk','/owned/destination'])
  self.assertEqual(c.call_count,1);del s['selectedTcpAdb']
  with patch.object(S.subprocess,'check_output') as c,self.assertRaises(ValueError):S.adb_command(s,['get-state'])
  c.assert_not_called()
 def test_expected_root_and_reboot_only_rebind_same_guest_routes(self):
  s=state(Path('/owned'));bind(s);new={**FACT,'adbdPid':102,'adbdStartTicks':'2222'}
  with patch.object(T,'listener'),patch.object(T,'connect'),patch.object(T,'guest',side_effect=[new,new]),patch.object(T,'command',return_value='0'):
   self.assertTrue(T.reattach(s,Path('/owned'),{},time.monotonic()+10,'root',lambda *a:None))
  self.assertEqual(s['selectedTcpAdb']['guest'],new)
  with patch.object(T,'listener'),patch.object(T,'connect'),patch.object(T,'guest',side_effect=[new,new]),patch.object(T,'command',return_value='1'):self.assertFalse(T.reattach(s,Path('/owned'),{},time.monotonic()+10,'root',lambda *a:None))
  with patch.object(T,'listener'),patch.object(T,'connect'),patch.object(T,'guest',side_effect=[new,new]):self.assertFalse(T.reattach(s,Path('/owned'),{},time.monotonic()+10,'reboot',lambda *a:None))
  reboot={**new,'bootIdSha256':'b'*64}
  with patch.object(T,'listener'),patch.object(T,'connect'),patch.object(T,'guest',side_effect=[reboot,reboot]),patch.object(T,'command',side_effect=lifecycle_command(['1','1'])):self.assertTrue(T.reattach(s,Path('/owned'),{},time.monotonic()+10,'reboot',lambda *a:None,restoration_context={}))
  with patch.object(T,'listener'),patch.object(T,'connect'),patch.object(T,'guest',side_effect=[reboot,{**reboot,'adbdPid':999}]),patch.object(T,'command',return_value='0'),self.assertRaises(ValueError):T.reattach(s,Path('/owned'),{},time.monotonic()+10,'root',lambda *a:None)
  with self.assertRaises(ValueError):T.reattach(s,Path('/owned'),{},time.monotonic()+10,'runtime',lambda *a:None)
  with patch.object(T,'listener'),patch.object(T,'connect'),patch.object(T,'guest',side_effect=[reboot,new]),self.assertRaises(ValueError):T.reattach(s,Path('/owned'),{},time.monotonic()+10,'root',lambda *a:None)
 def test_reboot_two_polls_does_not_commit_new_boot_until_boot_complete(self):
  s=state(Path('/owned'));bind(s);new={**FACT,'bootIdSha256':'b'*64,'adbdPid':102,'adbdStartTicks':'2222'};saved=[];context={}
  with patch.object(T,'listener'),patch.object(T,'connect'),patch.object(T,'guest',side_effect=[new,new,new,new]),patch.object(T,'command',side_effect=lifecycle_command(['1','0','1','1'])) as command:
   self.assertFalse(T.reattach(s,Path('/owned'),{},time.monotonic()+10,'reboot',lambda *args:saved.append(args),restoration_context=context));self.assertEqual(s['selectedTcpAdb']['guest'],FACT);self.assertEqual(saved,[])
   self.assertTrue(T.reattach(s,Path('/owned'),{},time.monotonic()+10,'reboot',lambda *args:saved.append(args),restoration_context=context));self.assertEqual(s['selectedTcpAdb']['guest'],new);self.assertEqual(len(saved),2)
  self.assertEqual([c.args[3] for c in command.call_args_list if c.args[3]==['shell','getprop','sys.boot_completed']],[['shell','getprop','sys.boot_completed']]*4);self.assertEqual(sum(c.args[3]==['shell','cmd','wifi','connect-network','AndroidWifi','open'] for c in command.call_args_list),1)
 def test_unprepared_route_refuses_before_log_or_commands(self):
  s=state(Path('/owned'))
  with patch.object(T,'command') as command,patch.object(Path,'lstat',side_effect=AssertionError('no unrelated file read')),self.assertRaisesRegex(ValueError,'predeclared'):T.initial(s,Path('/owned'),{},time.monotonic()+10,lambda *a:None)
  command.assert_not_called()
 def test_deadline_refuses_before_subprocess(self):
  with patch.object(T.subprocess,'check_output') as c,self.assertRaises(TimeoutError):T.command({'sdk':'/owned','adbPort':12345},{},None,['connect','127.0.0.1:12346'],time.monotonic()-1)
  c.assert_not_called()
 def test_late_command_listener_and_final_binding_do_not_admit(self):
  clock=[0]
  def late(*args,**kwargs):clock[0]=11;return 'connected to 127.0.0.1:12346'
  with patch.object(T.time,'monotonic',side_effect=lambda:clock[0]),patch.object(T.subprocess,'check_output',side_effect=late),self.assertRaises(TimeoutError):T.command({'sdk':'/owned','adbPort':12345},{},None,['connect','127.0.0.1:12346'],10,cap=12)
  with patch.object(T.time,'monotonic',side_effect=[0,11]),patch.object(T.subprocess,'run',return_value=type('R',(),{'stdout':b'p777\nf99\nn127.0.0.1:12346\n','stderr':b'','returncode':0})()),self.assertRaises(TimeoutError):T.listener(state(Path('/owned')),12346,10)
  s=state(Path('/owned'));bind(s);saved=[]
  with patch.object(T,'listener'),patch.object(T,'connect'),patch.object(T,'guest',side_effect=[FACT,FACT]),patch.object(T,'command',return_value='0'),patch.object(T.time,'monotonic',return_value=11),self.assertRaises(TimeoutError):T.reattach(s,Path('/owned'),{},10,'root',lambda *args:saved.append(args))
  self.assertEqual(saved,[])
 def test_save_returning_late_is_failure_even_when_private_binding_was_written(self):
  s=state(Path('/owned'));bind(s);clock=[0];saved=[]
  def save(path,value):saved.append(path);clock[0]=11
  with patch.object(T,'listener'),patch.object(T,'connect'),patch.object(T,'guest',side_effect=[FACT,FACT]),patch.object(T,'command',return_value='0'),patch.object(T.time,'monotonic',side_effect=lambda:clock[0]),self.assertRaises(TimeoutError):T.reattach(s,Path('/owned'),{},10,'root',save)
  self.assertEqual(len(saved),2)
 def test_only_connect_gets_twelve_second_budget_and_late_metadata_fails(self):
  s=state(Path('/owned'));clock=[0];budgets=[]
  def result(*args,**kwargs):budgets.append(kwargs['timeout']);return 'connected to 127.0.0.1:12346'
  with patch.object(T.time,'monotonic',side_effect=lambda:clock[0]),patch.object(T.subprocess,'check_output',side_effect=result):T.command(s,{},None,['connect','127.0.0.1:12346'],100,cap=12)
  self.assertEqual(budgets,[12])
  with patch.object(T.subprocess,'check_output') as c,self.assertRaises(ValueError):T.command(s,{},s['serial'],['shell','id'],time.monotonic()+20,cap=12)
  c.assert_not_called()
  def late(*args,**kwargs):clock[0]=4;return 'bytes'
  with patch.object(T.time,'monotonic',side_effect=lambda:clock[0]),patch.object(T.subprocess,'check_output',side_effect=late),self.assertRaises(TimeoutError):T.command(s,{},s['serial'],['shell','id'],100)
 def test_connect_pending_is_narrow_and_only_in_expected_lifecycle(self):
  s=state(Path('/owned'));target='127.0.0.1:12346'
  with patch.object(T,'command',return_value=f"failed to connect to '{target}': Connection refused"):
   with self.assertRaises(T.ExpectedAttachmentPending):T.connect(s,{},target,time.monotonic()+10,expected_transition=True)
   with self.assertRaises(ValueError):T.connect(s,{},target,time.monotonic()+10)
  with patch.object(T,'command',return_value='failed to connect to '+target),self.assertRaises(T.ExpectedAttachmentPending):T.connect(s,{},target,time.monotonic()+10,expected_transition=True)
  for value in ('failed to authenticate to '+target,"failed to connect to '127.0.0.1:12347': Connection refused",'arbitrary error','connected to 127.0.0.1:12347'):
   with patch.object(T,'command',return_value=value),self.assertRaises(ValueError):T.connect(s,{},target,time.monotonic()+10,expected_transition=True)
 def test_route_observation_keeps_unexpected_interface_without_relaxing_guard(self):
   facts=T.egress_routes(b'default dev dummy0 table legacy_system scope link\n10.0.2.0/24 dev wlan0 proto kernel scope link\n')
   self.assertEqual(facts['extraEgressRoutes'],1);self.assertEqual(facts['observedInterfaceCounts'],{'dummy0':1,'wlan0':1});self.assertEqual(facts['allowedInterfaces'],['lo','wlan0'])
   with self.assertRaises(ValueError):T.egress_routes(b'default dev unknown/invalid\n')
 def test_dummy_requires_native_kind_and_fixed_default_discard_route(self):
   raw=b'3: dummy0: <BROADCAST,NOARP,UP,LOWER_UP> mtu 1500\n    link/ether 02:00:00:00:00:00 brd ff:ff:ff:ff:ff:ff\n    dummy addrgenmode eui64\n';d=T.dummy_link(raw)
   self.assertEqual(d,{'interface':'dummy0','index':3,'kind':'dummy','routeTable':1003})
   route=b'default dev dummy0 table 1003 proto static scope link\n'
   self.assertEqual(T.egress_routes(route,d)['extraEgressRoutes'],0);self.assertEqual(T.egress_routes(route,d)['verifiedDiscardRoutes'],1);self.assertEqual(T.egress_routes(route.replace(b'table 1003',b'table dummy0'),d)['verifiedDiscardRoutes'],1)
   for broken in (raw.replace(b'dummy addrgen',b'tun addrgen'),raw.replace(b'3: dummy0',b'3: wlan0')):
    with self.assertRaises(ValueError):T.dummy_link(broken)
   for broken in (route.replace(b'table 1003',b'table 1004'),route.replace(b'default dev',b'default via 10.0.2.2 dev'),route+route,route.replace(b'default',b'10.0.2.0/24')):
    with self.assertRaises(ValueError):T.egress_routes(broken,d)
   self.assertEqual(T.egress_routes(b'default via 10.0.2.2 dev eth0\n',d)['extraEgressRoutes'],1)
if __name__=='__main__':unittest.main()
