"""Actual command/observe path preserves the kernel query's complete framing."""
import ast,hashlib,importlib.util,json,shlex,subprocess,tempfile,time,unittest
from pathlib import Path
from unittest.mock import patch
from test_android_tcp import T,S,state,FACT
class KernelRoute(unittest.TestCase):
 def test_actual_initial_command_observe_keeps_footer_and_uses_fixed_su_read(self):
  with tempfile.TemporaryDirectory() as d:
   run=Path(d);(run/'private').mkdir();s=state(run);s['ownedWifiTcpSetup']={'hostPort':12346,'radioOptions':'restrict=on','wifiOptions':'restrict=on,dhcpstart=10.0.2.16,hostfwd=tcp:127.0.0.1:12346-10.0.2.16:5555'}
   (run/'private/emulator.log').write_text('argv[01] = "user,id=mynet,restrict=on"\nargv[02] = "user,id=virtio-wifi,'+s['ownedWifiTcpSetup']['wifiOptions']+'"\n')
   frame=b'10.0.2.2 from 10.0.2.16 dev wlan0 table wlan0 uid 2000\n    cache\n\nOBSYNC_ROUTE_EXIT=0\nOBSYNC_ROUTE_DONE\n';calls=[];saved=[];data_reads=[0]
   def execute(argv,**kwargs):
    args=argv[5:] if argv[3]=='-s' else argv[3:];calls.append((args,kwargs['text'],argv[4] if argv[3]=='-s' else None))
    if args==['shell','cat','/proc/101/status']:self.assertFalse(kwargs['text']);return b'Name:\tadbd\nUid:\t2000\t2000\t2000\t2000\n'
    if args[:3]==['shell','sh','-c']:
     script=shlex.split(args[3]);self.assertEqual(len(script),1);self.assertIn('uid 2000 mark 0',script[0]);self.assertFalse(kwargs['text']);return frame
    self.assertTrue(kwargs['text'])
    if args==['shell','cmd','wifi','status']:return 'Wifi is enabled\nWifi is connected to "AndroidWifi"\n'
    if args==['shell','ip','-o','-4','addr','show']:return '5: wlan0 inet 10.0.2.16/24 scope global wlan0\n'
    if args==['connect','127.0.0.1:12346']:return 'connected to 127.0.0.1:12346\n'
    if args==['shell','/system/xbin/su','0','/system/bin/ip','-d','link','show','dev','dummy0']:return '3: dummy0: <UP>\n    dummy addrgenmode eui64\n'
    if args==['shell','settings','get','global','mobile_data']:data_reads[0]+=1;return '1\n' if data_reads[0]==1 else '0\n'
    if args==['shell','ip','-4','route','show','table','all']:return 'default dev dummy0 table 1003 proto static scope link\n'
    return ''
   with patch.object(T.subprocess,'check_output',side_effect=execute),patch.object(T,'guest',side_effect=[FACT,FACT]),patch.object(T,'listener',return_value={'pid':777}):T.initial(s,run,{},time.monotonic()+10,lambda p,v:saved.append((p,v)),S.APK.apk_command_failure)
   proof=saved[-1][1];self.assertEqual(proof['adbdUid'],2000);self.assertTrue(proof['guestResponseRouteReadiness']['ready']);self.assertEqual(proof['dummyProofPrivilege'],'USERDEBUG_SU_READONLY_CHILD_SELINUX_PERMISSIVE_NOT_STOCK_SHELL')
   self.assertEqual([row[0] for row in calls[:5]],[['shell','settings','get','global','mobile_data'],['shell','settings','put','global','mobile_data','0'],['shell','svc','data','disable'],['shell','settings','get','global','mobile_data'],['shell','svc','wifi','enable']]);self.assertTrue(all(row[2]=='emulator-5584' for row in calls[:5]));self.assertEqual(proof['dataBeforeProvisioningValueClass'],'ONE');self.assertEqual(proof['dataBeforeWifiRoutingValueClass'],'ZERO');self.assertTrue(proof['mobileDataGlobalSettingZero'])
   query=next(x for x in proof['commands'] if x['stage']=='guest_response_route_readiness');self.assertEqual(query['stdoutBytes'],len(frame));self.assertEqual(query['stdoutSha256'],hashlib.sha256(frame).hexdigest());self.assertEqual(sum(x[0][:1]==['connect'] for x in calls),1)
 def test_actual_early_data_block_refuses_nonzero_or_failed_command_before_wifi(self):
  tree=ast.parse(Path(T.__file__).read_text());fn=next(n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name=='initial');body=next(n for n in fn.body if isinstance(n,ast.Try)).body
  start=next(i for i,n in enumerate(body) if isinstance(n,ast.Assign) and ast.unparse(n.targets[0])=='data_value');end=next(i for i,n in enumerate(body[start:],start) if isinstance(n,ast.Expr) and 'enable_only_owned_guest_wifi_once' in ast.unparse(n))
  code=compile(ast.fix_missing_locations(ast.Module(body=body[start:end],type_ignores=[])),'actual-early-data-block','exec')
  for failed in (False,True):
   calls=[]
   def observe(stage,target,argv,cap):
    calls.append((stage,target,argv,cap))
    if failed and argv==['shell','settings','put','global','mobile_data','0']:raise subprocess.TimeoutExpired('fixed',30)
    return '1' if argv==['shell','settings','get','global','mobile_data'] else ''
   scope={'proof':{},'observe':observe,'state':{'serial':'emulator-5584'}}
   with self.assertRaises(subprocess.TimeoutExpired if failed else ValueError):exec(code,scope)
   self.assertEqual(sum(row[2]==['shell','settings','put','global','mobile_data','0'] for row in calls),1);self.assertTrue(all(row[1]=='emulator-5584' and row[3]==30 for row in calls))
 def test_each_response_route_call_resamples_uid_and_failed_command_never_retries(self):
  s=state(Path('/owned'))
  for uid in (2000,0):
   status=f'Uid:\t{uid}\t{uid}\t{uid}\t{uid}\n'.encode();frame=f'10.0.2.2 from 10.0.2.16 dev wlan0 uid {uid}\n\nOBSYNC_ROUTE_EXIT=0\nOBSYNC_ROUTE_DONE\n'.encode();proof={}
   with patch.object(T.subprocess,'check_output',side_effect=[status,frame]) as c:T.response_route_ready(s,{},s['serial'],FACT,time.monotonic()+10,proof)
   self.assertEqual(c.call_count,2);self.assertEqual(proof['adbdUid'],uid);self.assertTrue(all(call.kwargs['text'] is False for call in c.call_args_list));self.assertIn(f'uid {uid} mark 0',shlex.split(c.call_args.args[0][-1])[0])
  error=subprocess.CalledProcessError(1,[],stderr=b'device offline')
  with patch.object(T.subprocess,'check_output',side_effect=[status,error]) as c,self.assertRaises(subprocess.CalledProcessError) as caught:T.response_route_ready(s,{},s['serial'],FACT,time.monotonic()+10,{})
  self.assertIs(caught.exception,error);self.assertEqual(c.call_count,2)
 def test_actual_session_initial_call_supplies_closed_failure_classifier(self):
  tree=ast.parse(Path(S.__file__).read_text());call=next(x for x in ast.walk(tree) if isinstance(x,ast.Call) and ast.unparse(x.func)=='TCP.initial')
  with patch.object(T,'initial') as initial:
   exec(compile(ast.fix_missing_locations(ast.Module(body=[ast.Expr(call)],type_ignores=[])),S.__file__,'exec'),{'TCP':T,'state':{},'a':type('A',(),{'run':Path('/owned')})(),'env':{},'boot_deadline':1,'save':object(),'APK':S.APK})
  self.assertIs(initial.call_args.args[-1],S.APK.apk_command_failure)

 def test_actual_route_lookup_requires_frame_correct_source_uid_and_interface(self):
   raw=b'10.0.2.2 from 10.0.2.16 dev wlan0 table 1005 uid 2000\n    cache \n\nOBSYNC_ROUTE_EXIT=0\nOBSYNC_ROUTE_DONE\n'
   self.assertTrue(T.route_lookup(raw,2000)['ready']);self.assertFalse(T.route_lookup(raw.replace(b'wlan0',b'dummy0'),2000)['ready'])
   for broken in (raw[:-3],raw.replace(b'uid 2000',b'uid 0'),raw.replace(b'10.0.2.16',b'10.0.2.15'),raw.replace(b'wlan0',b'eth0'),raw.replace(b'EXIT=0',b'EXIT=1'),raw.replace(b' cache ',b' private arbitrary ')):
    with self.assertRaises(ValueError):T.route_lookup(broken,2000)
   self.assertFalse(T.route_lookup(b'RTNETLINK answers: Network is unreachable\n\nOBSYNC_ROUTE_EXIT=2\nOBSYNC_ROUTE_DONE\n',2000)['ready'])
   self.assertEqual(T.adbd_uid(b'Name:\tadbd\nUid:\t2000\t2000\t2000\t2000\n'),2000)
   with self.assertRaises(ValueError):T.adbd_uid(b'Uid:\t0\t2000\t2000\t2000\n')

 def test_route_wait_never_retries_failed_read_or_accepts_late_ready(self):
   clock=[0];proof={};calls=[]
   def pause(x):clock[0]+=x
   def read():calls.append(1);return {'ready':len(calls)==2,'state':'test'}
   T.wait_route(read,1,proof,lambda:clock[0],pause);self.assertEqual(len(calls),2);self.assertTrue(proof['guestResponseRouteReadiness']['ready'])
   def failed():raise RuntimeError('synthetic failed ADB')
   with self.assertRaises(RuntimeError):T.wait_route(failed,1,{},lambda:clock[0],pause)
   clock[0]=0
   def late():clock[0]=1.1;return {'ready':True}
   with self.assertRaises(TimeoutError):T.wait_route(late,1,{},lambda:clock[0],pause)
   clock[0]=0
   with self.assertRaises(TimeoutError):T.wait_route(lambda:{'ready':False},1,{},lambda:clock[0],pause)

if __name__=='__main__':unittest.main()
