"""Only exact owned Binder/framework provisioning recovers shared30s budget."""
import ast,importlib.util,time,unittest
from pathlib import Path
from unittest.mock import patch
B=Path(__file__).parent
spec=importlib.util.spec_from_file_location('budget19',B/'emulator-tcp.py');T=importlib.util.module_from_spec(spec);spec.loader.exec_module(T)
class Budget(unittest.TestCase):
 def state(self):return {'sdk':'/owned/sdk','adbPort':12345,'serial':'emulator-5584','ownedWifiTcpSetup':{'hostPort':12346}}
 def test_exact_framework_allowlist_only_and_owned_target(self):
  s=self.state();caps=[]
  def output(*args,**kwargs):caps.append(kwargs['timeout']);return '0\n'
  with patch.object(T.time,'monotonic',return_value=0),patch.object(T.subprocess,'check_output',side_effect=output):
   for argv in T.FRAMEWORK_PROVISIONING:
    target=s['serial'] if argv in (('shell','svc','wifi','enable'),('shell','cmd','wifi','connect-network','AndroidWifi','open')) else '127.0.0.1:12346';T.command(s,{},target,list(argv),100,cap=30)
  self.assertEqual(caps,[30]*5)
  for argv,target,binary in [(['shell','settings','put','global','mobile_data','1'],'127.0.0.1:12346',False),(['shell','settings','get','secure','mobile_data'],'127.0.0.1:12346',False),(['shell','svc','wifi','disable'],s['serial'],False),(['shell','svc','data','enable'],'127.0.0.1:12346',False),(['shell','cat','/proc/101/status'],s['serial'],False),(['connect','127.0.0.1:12346'],None,False),(['shell','settings','get','global','mobile_data'],'127.0.0.1:12347',False),(['shell','settings','get','global','mobile_data'],'127.0.0.1:12346',True)]:
   with patch.object(T.subprocess,'check_output') as child,self.assertRaises(ValueError):T.command(s,{},target,argv,time.monotonic()+100,cap=30,binary=binary)
   child.assert_not_called()
 def test_early_data_original_target_requires_isolated_unselected_and_exact_argv(self):
  s=self.state()|{'adbTransport':'isolated-tcp'};argv=['shell','settings','put','global','mobile_data','0']
  with patch.object(T.subprocess,'check_output',return_value='') as child:T.command(s,{},s['serial'],argv,time.monotonic()+100,cap=30)
  self.assertEqual(child.call_count,1);self.assertLessEqual(child.call_args.kwargs['timeout'],30)
  for change in ({'selectedTcpAdb':{}},{'adbTransport':'emulator'},{'adbTransport':'usb'}):
   with patch.object(T.subprocess,'check_output') as child,self.assertRaises(ValueError):T.command(s|change,{},s['serial'],argv,time.monotonic()+100,cap=30)
   child.assert_not_called()
  for args,target in [(argv[:-1]+['1'],s['serial']),(argv,'emulator-5582')]:
   with patch.object(T.subprocess,'check_output') as child,self.assertRaises(ValueError):T.command(s,{},target,args,time.monotonic()+100,cap=30)
   child.assert_not_called()
 def test_same_boot_deadline_clips_framework_and_late_success_refuses(self):
  s=self.state();clock=[0];caps=[]
  def output(*args,**kwargs):caps.append(kwargs['timeout']);return '0\n'
  with patch.object(T.time,'monotonic',side_effect=lambda:clock[0]),patch.object(T.subprocess,'check_output',side_effect=output):
   T.command(s,{},'127.0.0.1:12346',['shell','settings','get','global','mobile_data'],10,cap=30);T.command(s,{},s['serial'],['shell','cat','/proc/101/status'],100);T.command(s,{},None,['connect','127.0.0.1:12346'],100,cap=12)
  self.assertEqual(caps,[10,3,12])
  def late(*args,**kwargs):clock[0]=10.001;return '0\n'
  with patch.object(T.time,'monotonic',side_effect=lambda:clock[0]),patch.object(T.subprocess,'check_output',side_effect=late) as child,self.assertRaises(TimeoutError):T.command(s,{},'127.0.0.1:12346',['shell','settings','get','global','mobile_data'],10,cap=30)
  self.assertEqual(child.call_count,1)
 def test_actual_initial_calls_use30_only_for_six_prescribed_framework_operations(self):
  tree=ast.parse((B/'emulator-tcp.py').read_text());fn=next(n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name=='initial');calls=[n for n in ast.walk(fn) if isinstance(n,ast.Call) and isinstance(n.func,ast.Name) and n.func.id=='observe'];framework=[]
  for c in calls:
   if len(c.args)<3 or not isinstance(c.args[2],ast.List) or not all(isinstance(e,ast.Constant) for e in c.args[2].elts):continue
   argv=ast.literal_eval(c.args[2])
   if tuple(argv) in T.FRAMEWORK_PROVISIONING:framework.append(argv);self.assertEqual(next((ast.literal_eval(k.value) for k in c.keywords if k.arg=='cap'),3),30)
   else:self.assertNotEqual(next((ast.literal_eval(k.value) for k in c.keywords if k.arg=='cap'),3),30)
  self.assertEqual(len(framework),6)
if __name__=='__main__':unittest.main()
