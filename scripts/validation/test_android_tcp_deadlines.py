"""Actual caller loops only; no processes, devices or clocks are changed."""
import ast,subprocess,time,unittest
from pathlib import Path
from types import SimpleNamespace
B=Path(__file__).parent

def actual_loop(name,phase):
 tree=ast.parse((B/name).read_text());loops=[n for n in ast.walk(tree) if isinstance(n,ast.While) and ast.unparse(n.test)=='time.monotonic() < deadline']
 return next(n for n in loops if any(isinstance(x,ast.Name) and x.id==('SESSION' if phase=='root' else 'reattach_tcp') for x in ast.walk(n)))

def run_loop(phase,late=None):
 end=20 if phase=='root' else 240;clock=[end-.01];calls=[]
 def remaining(deadline):
  if clock[0]>=deadline:raise TimeoutError('same phase deadline')
  return min(3,deadline-clock[0])
 def attach(*args):
  calls.append('reattach')
  if late=='attach':clock[0]=end+.001
  return True
 def adb(state,args,timeout):
  calls.append(args[-1]);assert 0<timeout<=.01+.000001
  if late=='first' or late=='last' and args[-1]=='sys.boot_completed':clock[0]=end+.001
  return 'new' if args[-1]=='/proc/sys/kernel/random/boot_id' else '1'
 def shell(*args):calls.append('unexpected redundant uid read');clock[0]=end+.001;return '0'
 pending=type('Pending',(Exception,),{});tcp=SimpleNamespace(remaining=remaining,ExpectedAttachmentPending=pending);session=SimpleNamespace(register_emulator=lambda *args:None,reattach_tcp=attach,TCP=tcp)
 scope={'time':SimpleNamespace(monotonic=lambda:clock[0],sleep=lambda _:None),'deadline':end,'state':{'serial':'emulator-5584','adbTransport':'isolated-tcp'},'run':Path('/not-used'),'SESSION':session,'TCP':tcp,'shell':shell,'subprocess':subprocess,'register_emulator':lambda *args:None,'reattach_tcp':attach,'adb_command':adb,'before':'old','after':None}
 node=actual_loop('android-trust.py' if phase=='root' else 'android-session.py',phase)
 exec(compile(ast.fix_missing_locations(ast.Module(body=[node],type_ignores=[])),phase,'exec'),scope)
 return calls,clock[0],end

class Callers(unittest.TestCase):
 def test_actual_root_deadline_is_clipped_to_session_expiry(self):
  tree=ast.parse((B/'android-trust.py').read_text());fn=next(n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name=='install');nodes=[n for n in fn.body if isinstance(n,ast.Assign) and any(isinstance(x,ast.Name) and x.id=='deadline' for x in n.targets) or isinstance(n,ast.If) and any(isinstance(x,ast.Assign) and any(isinstance(t,ast.Name) and t.id=='deadline' for t in x.targets) for x in n.body)]
  code=compile(ast.fix_missing_locations(ast.Module(body=nodes,type_ignores=[])),'actual-root-budget','exec')
  for expires,expected in [(1000.25,5.25),(990,5),(1100,25)]:
   scope={'state':{'adbTransport':'isolated-tcp','expiresAtEpoch':expires},'time':SimpleNamespace(monotonic=lambda:5,time=lambda:1000)};exec(code,scope);self.assertEqual(scope['deadline'],expected)
 def test_root_has_no_redundant_unbounded_read_after_bound_helper(self):
  calls,now,end=run_loop('root');self.assertEqual(calls,['reattach']);self.assertLess(now,end)
 def test_root_refuses_late_admission_at_caller_boundary(self):
  with self.assertRaises(TimeoutError):run_loop('root','attach')
 def test_reboot_remaining_and_final_checks_refuse_late_first_or_last_read(self):
  for late in ('first','last'):
   with self.subTest(late=late),self.assertRaises(TimeoutError):run_loop('reboot',late)
 def test_reboot_timely_independent_receipt_reads_still_admit(self):
  calls,now,end=run_loop('reboot');self.assertEqual(calls,['reattach','/proc/sys/kernel/random/boot_id','sys.boot_completed']);self.assertLess(now,end)
if __name__=='__main__':unittest.main()
