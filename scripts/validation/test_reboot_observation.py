"""Actual helper and extracted controller loop; no device/process/socket calls."""
import ast,copy,hashlib,importlib.util,json,subprocess,unittest
from contextlib import ExitStack
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
B=Path(__file__).parent
sp=importlib.util.spec_from_file_location('observed_session',B/'android-session.py');S=importlib.util.module_from_spec(sp);sp.loader.exec_module(S);T=S.TCP
OLD={'bootIdSha256':'a'*64,'adbdPid':100,'adbdStartTicks':'10'}
FRAME=('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb\n101\n101 (adbd) '+' '.join(['S']+['0']*18+['20'])+'\nOBSYNC_GUEST_IDENTITY_COMPLETE\nUid:\t2000\t2000\t2000\t2000\nOBSYNC_INCOMING_GUEST_COMPLETE\n').encode()
NEW=T.identity(b''.join(FRAME.splitlines(keepends=True)[:4]))
def state():
 s={'rebootWifiRestoration':{'method':T.WIFI_RESTORATION_METHOD,'sourceHead':'a'*40,'initialBootIdSha256':OLD['bootIdSha256'],'initialKnownNetworkConnected':True},'sourceHead':'a'*40,'serial':'emulator-5584','adbTransport':'isolated-tcp','expiresAtEpoch':1300,'ownedWifiTcpSetup':{'hostPort':12346,'radioOptions':'restrict=on','wifiOptions':'restrict=on,dhcpstart=10.0.2.16,hostfwd=tcp:127.0.0.1:12346-10.0.2.16:5555'},'processes':{'emulator':{'pid':777,'identity':'owned qemu'}}};T.save_binding(s,Path('/unused'),12346,OLD,'initial',lambda *a:None,OLD);return s

def helper(kind):
 s=state();events=[];observed=[];saved=[]
 def guest(st,env,target,end):
  events.append(('guest',target))
  if kind=='original-timeout':raise subprocess.TimeoutExpired('fixed',3,output=b'',stderr=b'device offline PRIVATE_SENTINEL')
  return OLD if kind=='unchanged' else NEW
 def command(st,env,target,args,end,**kw):
  events.append(('command',target,tuple(args)))
  if args==['shell','am','get-started-user-state','0']:return 'RUNNING_UNLOCKED'
  if args==['shell','cmd','wifi','connect-network','AndroidWifi','open']:return ''
  if args==['shell','getprop','sys.boot_completed']:return '0' if kind=='boot-incomplete' else '1'
  assert target=='127.0.0.1:12346' and args[:3]==['shell','sh','-c'] and kw.get('binary') is True and 'OBSYNC_INCOMING_GUEST_COMPLETE' in args[3]
  if kind=='incoming-timeout':raise subprocess.TimeoutExpired('incoming',3,output=b'',stderr=b'PRIVATE_SENTINEL')
  return FRAME
 def route(*args,**kw):raise AssertionError('reboot must use the actual incoming exchange')
 def connect(*args,**kw):
  events.append(('connect',))
  if kind=='connect-pending':raise T.ExpectedAttachmentPending('PRIVATE_SENTINEL')
  return 'connected to 127.0.0.1:12346'
 with ExitStack() as stack:
  stack.enter_context(patch.object(T.time,'monotonic',return_value=0))
  for name,fn in [('listener',lambda *a:T.listener_facts(b'p777\nf1\nn127.0.0.1:12346\n',777,12346)|{'pid':777,'address':'127.0.0.1:12346'}),('guest',guest),('command',command),('response_route_ready',route),('connect',connect),('save_binding',lambda *a:saved.append(True))]:stack.enter_context(patch.object(T,name,side_effect=fn))
  error=None;result=None
  try:result=T.reattach(s,Path('/unused'),{},240,'reboot',lambda *a:None,observed.append,S.APK.apk_command_failure,{})
  except Exception as e:error=e
 return result,error,observed,events,saved

class Observation(unittest.TestCase):
 def test_unchanged_and_incomplete_boot_remain_pending_before_connect(self):
  for kind,stage,reason in [('unchanged','original_guest_identity','ORIGINAL_BOOT_UNCHANGED'),('boot-incomplete','original_boot_completed','ORIGINAL_BOOT_NOT_COMPLETED')]:
   result,error,rows,events,saved=helper(kind);self.assertFalse(result);self.assertIsNone(error);self.assertEqual(len(rows),1);self.assertEqual(rows[0]['stage'],stage);self.assertEqual(rows[0]['pendingReason'],reason);self.assertNotIn(('connect',),events);self.assertFalse(saved)
  self.assertEqual(helper('boot-incomplete')[2][0]['originalBootCompleted']['valueClass'],'ZERO')
 def test_transport_failure_class_and_incoming_step_are_retained_without_error_text(self):
  for kind,stage in [('original-timeout','original_guest_identity'),('incoming-timeout','selected_guest_identity'),('connect-pending','selected_tcp_connect')]:
   result,error,rows,events,saved=helper(kind);self.assertIsNotNone(error);self.assertIsNone(result);self.assertEqual(rows[0]['result'],'ERROR');self.assertEqual(rows[0]['stage'],stage);self.assertNotIn('PRIVATE_SENTINEL',json.dumps(rows));self.assertFalse(saved)
   self.assertIn('exceptionType',rows[0]);self.assertEqual(rows[0]['exceptionType'],'ExpectedAttachmentPending' if kind=='connect-pending' else 'TimeoutExpired')
   if kind!='connect-pending':self.assertIn('commandFailure',rows[0])
  self.assertEqual(helper('original-timeout')[2][0]['commandFailure']['errorClass'],'transport_unavailable')
 def test_success_retains_both_guest_identities_and_measured_route(self):
  result,error,rows,events,saved=helper('success');self.assertTrue(result);self.assertIsNone(error);self.assertEqual(rows[0]['originalGuest'],NEW);self.assertEqual(rows[0]['selectedGuest'],NEW);self.assertEqual(rows[0]['routeProof']['adbdUid'],2000);self.assertEqual(rows[0]['routeProof']['incomingResponse']['stdoutSha256'],hashlib.sha256(FRAME).hexdigest());self.assertEqual(rows[0]['routeProof']['listener']['pid'],777);self.assertEqual(rows[0]['routeProof']['method'],'INCOMING_TCP_SAME_GUEST');self.assertEqual(saved,[True]);self.assertEqual(events.count(('connect',)),1)
 def loop(self,mode,save_error=False):
  tree=ast.parse((B/'android-session.py').read_text());fn=next(n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name=='lifecycle');branch=next(n for n in ast.walk(fn) if isinstance(n,ast.If) and ast.unparse(n.test)=="action == 'reboot'")
  start=next(i for i,n in enumerate(branch.body) if isinstance(n,ast.Assign) and isinstance(n.targets[0],ast.Name) and n.targets[0].id=='observation');end=next(i for i,n in enumerate(branch.body) if isinstance(n,ast.FunctionDef) and n.name=='tail_budget')
  clock=[0.];saved=[];calls=[0]
  def observe(st,run,deadline,phase,record,restoration_context):
   calls[0]+=1;record({'stage':'original_guest_identity','result':'PENDING','originalGuest':OLD,'attempt':calls[0]});return mode=='success'
  def save(path,value):
   saved.append((path,copy.deepcopy(value)))
   if save_error:raise OSError('PRIVATE_SENTINEL')
  def pause(v):clock[0]+=v
  scope={'state':state(),'run':Path('/owned'),'isolated':True,'deadline':.7,'before':'old','time':SimpleNamespace(monotonic=lambda:clock[0],sleep=pause),'subprocess':subprocess,'register_emulator':lambda *a:None,'reattach_tcp':observe,'TCP':SimpleNamespace(ExpectedAttachmentPending=T.ExpectedAttachmentPending,remaining=lambda *a:1),'APK':S.APK,'adb_command':lambda st,args,**kw:'new' if args[-1].endswith('boot_id') else '1','hashlib':hashlib,'save':save}
  error=None
  try:exec(compile(ast.fix_missing_locations(ast.Module(body=branch.body[start:end],type_ignores=[])),'actual-reboot-loop','exec'),scope)
  except Exception as e:error=e
  return saved,error,calls[0]
 def test_actual_loop_retains_one_bounded_first_last_file_after_deadline(self):
  saved,error,count=self.loop('pending');self.assertIsInstance(error,TimeoutError);self.assertEqual(len(saved),1);path,proof=saved[0];self.assertEqual(path.name,'owned-reboot-reattachment-observation.json');self.assertEqual(proof['terminal'],'FAILED');self.assertEqual(proof['sourceHead'],'a'*40);row=proof['stages']['original_guest_identity'];self.assertEqual(row['count'],count);self.assertEqual(row['first']['attempt'],1);self.assertEqual(row['last']['attempt'],count);self.assertEqual(proof['counts']['PENDING'],count)
 def test_actual_loop_final_selected_proof_and_primary_error_preservation(self):
  saved,error,count=self.loop('success');self.assertIsNone(error);self.assertEqual(count,1);self.assertTrue(saved[0][1]['stages']['selected_final_boot_proof']['last']['bootChanged']);self.assertEqual(saved[0][1]['terminal'],'REATTACHED')
  saved,error,count=self.loop('pending',True);self.assertIsInstance(error,TimeoutError);self.assertNotIn('PRIVATE_SENTINEL',str(error))

if __name__=='__main__':unittest.main()
