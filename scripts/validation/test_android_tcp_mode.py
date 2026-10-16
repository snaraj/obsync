import ast,importlib.util,subprocess,time,unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
B=Path(__file__).parent
spec=importlib.util.spec_from_file_location('mode_session',B/'android-session.py');S=importlib.util.module_from_spec(spec);spec.loader.exec_module(S)
class Mode(unittest.TestCase):
 def state(self):return {'sdk':'/owned/sdk','adbPort':12345,'serial':'emulator-5584','expiresAtEpoch':time.time()+100,'environment':{},'processes':{'emulator':{'pid':777,'identity':'owned qemu'}}}
 def test_legacy_and_usb_keep_original_target(self):
  for usb in (False,True):
   s=self.state()
   if usb:s.update(targetKind='usb',serial='explicit-usb')
   with patch.object(S.subprocess,'check_output',return_value='0') as call:S.adb_command(s,['shell','id','-u'])
   self.assertEqual(call.call_args.args[0][3:5],['-s',s['serial']])
 def test_isolated_missing_binding_or_legacy_with_selected_binding_never_falls_back(self):
  for change in ({'adbTransport':'isolated-tcp'},{'selectedTcpAdb':{}},{'adbTransport':'unknown'}):
   s=self.state()|change
   with patch.object(S.subprocess,'check_output') as call,self.assertRaises(ValueError):S.adb_command(s,['shell','id','-u'])
   call.assert_not_called()
 def test_only_explicit_isolated_online_is_refused_before_validation(self):
  with patch.object(S,'validate',side_effect=AssertionError('no validation before refusal')) as validate,self.assertRaisesRegex(ValueError,'online'):S.execute(SimpleNamespace(adb_transport='isolated-tcp',online=True))
  validate.assert_not_called()
 def test_acceptance_constructs_explicit_transport_and_refuses_legacy_ready_state(self):
  spec=importlib.util.spec_from_file_location('acceptance_mode',B/'mobile-acceptance.py');M=importlib.util.module_from_spec(spec);spec.loader.exec_module(M);tree=ast.parse((B/'mobile-acceptance.py').read_text())
  child=next(n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name=='desktop_child');call=next(n for n in ast.walk(child) if isinstance(n,ast.Assign) and any(isinstance(t,ast.Name) and t.id=='command' for t in n.targets) and 'android-session.py' in ast.unparse(n))
  self.assertIn("'--adb-transport', 'isolated-tcp'",ast.unparse(call));self.assertIn('emulator-tcp.py',M.CORE_HELPERS);self.assertIn('tcp-target.mjs',M.CORE_HELPERS)
  android=next(n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name=='android_child');check=next(n for n in ast.walk(android) if isinstance(n,ast.If) and 'acceptance_isolated_tcp_binding_required' in ast.unparse(n))
  with self.assertRaises(M.StageFailure):exec(compile(ast.fix_missing_locations(ast.Module(body=[check],type_ignores=[])),'mode-admission','exec'),{'usb':False,'state':{},'require':M.require})
if __name__=='__main__':unittest.main()
