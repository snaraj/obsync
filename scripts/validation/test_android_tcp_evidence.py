"""Retained route provenance is required after private/runtime cleanup."""
import copy,importlib.util,tempfile,unittest
from pathlib import Path
B=Path(__file__).parent
spec=importlib.util.spec_from_file_location('tcp_retained',B/'mobile-acceptance.py');M=importlib.util.module_from_spec(spec);spec.loader.exec_module(M)
HEAD='a'*40
class Retained(unittest.TestCase):
 def fixture(self,root,mode):
  e=root/'evidence';e.mkdir();facts={'bootIdSha256':'a'*64,'adbdPid':101,'adbdStartTicks':'20'}
  initial={'schema':1,'sourceHead':HEAD,'result':'OBSERVED','sameGuestTcpBinding':True,'wifiNotDisabledAfterBinding':True,'mobileDataGlobalSettingZero':True,'connectAttempts':1,'ipv4RouteIsolation':{'extraEgressRoutes':0},'originalRouteGuest':facts,'selectedRouteGuest':facts,'effectiveNetworkOptions':{'ready':True,'radioArgumentMatches':1,'wifiArgumentMatches':1,'expectedRadioArgument':'user,id=mynet,restrict=on','expectedWifiArgument':'user,id=virtio-wifi,restrict=on,dhcpstart=10.0.2.16,hostfwd=tcp:127.0.0.1:12346-10.0.2.16:5555'}}
  M.save(e/'owned-wifi-route-initial.json',initial);prior=None;rows=[]
  for n,phase in enumerate(['initial','root'] if mode=='core' else ['initial','root','reboot','root']):
   if phase=='reboot':facts={**facts,'bootIdSha256':'b'*64,'adbdPid':201}
   elif phase=='root':facts={**facts,'adbdPid':facts['adbdPid']+1}
   row={'schema':1,'sourceHead':HEAD,'phase':phase,'guest':facts,'originalRouteGuest':facts,'selectedRouteGuest':facts,'priorGuest':prior,'target':'127.0.0.1:12346','originalSerial':'emulator-5584','emulatorPid':777,'loopbackListenerOwned':True,'sameGuestIndependentCommands':True,'authConfigurationUnchanged':True,'responseRouteProof':{'adbdUid':0,'guestResponseRouteReadiness':{'ready':True,'last':{'ready':True,'state':'WLAN0_ROUTE','uid':0}}}}
   path=e/f'owned-tcp-adb-{phase}-{n+1}.json';M.save(path,row);rows.append((path,row));prior=facts
  return initial,rows
 def test_core_and_full_admit_only_persisted_expected_phase_sequence(self):
  for mode,count in [('core',2),('full',4)]:
   with tempfile.TemporaryDirectory() as d:
    run=Path(d).resolve();self.fixture(run,mode);proof=M.isolated_tcp_evidence(run,HEAD,mode)
    self.assertEqual(proof['result'],'PASS');self.assertEqual(len(proof['files']),count+1)
    self.assertFalse((run/'private').exists());self.assertFalse((run/'android.json').exists())
 def test_missing_phase_wrong_source_or_changed_chain_refuses(self):
  with tempfile.TemporaryDirectory() as d:
   run=Path(d).resolve();initial,rows=self.fixture(run,'full');path,row=rows[-1];raw=path.read_bytes();path.unlink()
   with self.assertRaises(M.StageFailure):M.isolated_tcp_evidence(run,HEAD,'full')
   for change in [{'sourceHead':'b'*40},{'target':'127.0.0.1:12347'},{'priorGuest':None},{'emulatorPid':778},{'selectedRouteGuest':{}},{'responseRouteProof':{}},{'authConfigurationUnchanged':False}]:
    path.write_bytes(raw);path.chmod(0o600);path.unlink();M.save(path,row|change)
    with self.subTest(change=change),self.assertRaises(M.StageFailure):M.isolated_tcp_evidence(run,HEAD,'full')
   path.unlink();M.save(path,row)
   duplicate=run/'evidence/owned-tcp-adb-root-999.json';M.save(duplicate,row)
   with self.assertRaises(M.StageFailure):M.isolated_tcp_evidence(run,HEAD,'full')
 def test_wrong_boot_transition_or_initial_network_guard_never_admits(self):
  with tempfile.TemporaryDirectory() as d:
   run=Path(d).resolve();initial,rows=self.fixture(run,'core');path,row=rows[-1];changed={**row['guest'],'bootIdSha256':'b'*64};path.unlink();M.save(path,row|{'guest':changed,'originalRouteGuest':changed,'selectedRouteGuest':changed})
   with self.assertRaises(M.StageFailure):M.isolated_tcp_evidence(run,HEAD,'core')
   path.unlink();M.save(path,row);p=run/'evidence/owned-wifi-route-initial.json'
   for key,value in [('mobileDataGlobalSettingZero',False),('ipv4RouteIsolation',{'extraEgressRoutes':1}),('effectiveNetworkOptions',{}),('connectAttempts',2)]:
    p.unlink();M.save(p,initial|{key:value})
    with self.subTest(key=key),self.assertRaises(M.StageFailure):M.isolated_tcp_evidence(run,HEAD,'core')
 def test_root_receipt_must_prove_actual_zero_uid(self):
  with tempfile.TemporaryDirectory() as d:
   run=Path(d).resolve();_,rows=self.fixture(run,'core');path,row=rows[-1];route=copy.deepcopy(row['responseRouteProof']);route['adbdUid']=2000;route['guestResponseRouteReadiness']['last']['uid']=2000;path.unlink();M.save(path,row|{'responseRouteProof':route})
   with self.assertRaises(M.StageFailure):M.isolated_tcp_evidence(run,HEAD,'core')
 def test_final_hash_equality_detects_changed_persisted_witness(self):
  with tempfile.TemporaryDirectory() as d:
   run=Path(d).resolve();_,rows=self.fixture(run,'core');before=M.isolated_tcp_evidence(run,HEAD,'core');p,row=rows[-1];p.unlink();M.save(p,row|{'additionalSafeFact':True});after=M.isolated_tcp_evidence(run,HEAD,'core');self.assertNotEqual(before,after)
   source=(B/'mobile-acceptance.py').read_text();self.assertIn("require(private_json(attempt/'evidence/isolated-tcp-admission.json')==isolated_tcp_evidence",source)
   self.assertIn("save(args.attempt/'evidence/isolated-tcp-admission.json',isolated_tcp_evidence",source)
if __name__=='__main__':unittest.main()
