"""Fixed-port and primary-error controls. No native fixture or real port binds."""
import ast,errno,importlib.util,json,tempfile,unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
B=Path(__file__).parent
spec=importlib.util.spec_from_file_location('ports18',B/'mobile-acceptance.py');M=importlib.util.module_from_spec(spec);spec.loader.exec_module(M)
spec=importlib.util.spec_from_file_location('session18',B/'android-session.py');S=importlib.util.module_from_spec(spec);spec.loader.exec_module(S)
class Controls(unittest.TestCase):
 def test_all_three_fixed_ports_checked_and_closed_even_if_tls_conflicts(self):
  for conflict in (False,True):
   binds=[];closed=[]
   class Sock:
    def bind(self,address):
     binds.append(address)
     if conflict and address[1]==18474:raise OSError(errno.EADDRINUSE,'not promoted')
    def close(self):closed.append(True)
   with patch.object(M.socket,'socket',side_effect=Sock):proof=M.fixed_port_preflight({'sourceHead':'a'*40,'tlsPort':18474,'android':{}})
   self.assertEqual(binds,[('127.0.0.1',18474),('127.0.0.1',5584),('127.0.0.1',5585)]);self.assertEqual(len(closed),3);self.assertEqual(proof['result'],'FAIL' if conflict else 'PASS');self.assertEqual(proof['checks'][0]['status'],'ADDRESS_IN_USE' if conflict else 'AVAILABLE');self.assertFalse(proof['nativeFixtureStarted'])
 def test_duplicate_fixed_ports_refuse_before_any_socket(self):
  with patch.object(M.socket,'socket') as sock,self.assertRaises(M.StageFailure):M.fixed_port_preflight({'sourceHead':'a'*40,'tlsPort':5584,'android':{}})
  sock.assert_not_called()
 def test_missing_peer_preserves_known_controller_error_and_never_promotes_unknown_text(self):
  with tempfile.TemporaryDirectory() as d:
   attempt=Path(d).resolve();(attempt/'private').mkdir();(attempt/'evidence').mkdir();log=attempt/'private/mobile-controller.log';log.write_text(json.dumps({'result':'FAIL','exceptionType':'OSError','detail':'[Errno 48] Address already in use'})+'\n')
   error,cleanup=M.missing_peer_failure(attempt,1,'a'*40);self.assertEqual(error.stage,'controller_preflight_address_in_use');self.assertEqual(error.failure_class,'AUTOMATION_FAILURE');self.assertEqual(cleanup,'NOT_CREATED')
   (attempt/'evidence/controller-before-peer-failure.json').unlink();log.write_text(json.dumps({'result':'FAIL','exceptionType':'ValueError','detail':'SECRET_VALUE'})+'\n');error,cleanup=M.missing_peer_failure(attempt,1,'a'*40)
   self.assertEqual(error.stage,'controller_failed_before_peer_ValueError');self.assertEqual(error.failure_class,'UNCLASSIFIED');self.assertEqual(cleanup,'UNKNOWN');self.assertNotIn('SECRET_VALUE',(attempt/'evidence/controller-before-peer-failure.json').read_text())
 def test_actual_outer_missing_peer_branch_raises_primary_instead_of_filenotfound(self):
  tree=ast.parse((B/'mobile-acceptance.py').read_text());node=next(n for n in ast.walk(tree) if isinstance(n,ast.If) and 'peer-result.json' in ast.unparse(n.test))
  with tempfile.TemporaryDirectory() as d:
   attempt=Path(d).resolve();(attempt/'private').mkdir();(attempt/'evidence').mkdir();(attempt/'private/mobile-controller.log').write_text(json.dumps({'result':'FAIL','exceptionType':'OSError','detail':'[Errno 48] Address already in use'})+'\n');scope={'attempt':attempt,'result':SimpleNamespace(returncode=1),'c':{'sourceHead':'a'*40},'missing_peer_failure':M.missing_peer_failure}
   with self.assertRaises(M.StageFailure) as failure:exec(compile(ast.fix_missing_locations(ast.Module(body=[node],type_ignores=[])),'actual-outer','exec'),scope)
   self.assertEqual(failure.exception.stage,'controller_preflight_address_in_use');self.assertEqual(scope['cleanup'],'NOT_CREATED')
 def test_online_is_explicitly_refused_before_validation_or_fixture(self):
  with patch.object(S,'validate',side_effect=AssertionError('fixture validation must not run')) as validate,self.assertRaisesRegex(ValueError,'online'):S.execute(SimpleNamespace(online=True,adb_transport='isolated-tcp'))
  validate.assert_not_called()
if __name__=='__main__':unittest.main()
