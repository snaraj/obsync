"""Retained route provenance is required after private/runtime cleanup."""
import copy,hashlib,importlib.util,tempfile,unittest
from pathlib import Path
B=Path(__file__).parent
spec=importlib.util.spec_from_file_location('tcp_retained',B/'mobile-acceptance.py');M=importlib.util.module_from_spec(spec);spec.loader.exec_module(M)
HEAD='a'*40
class Retained(unittest.TestCase):
 def fixture(self,root,mode):
  e=root/'evidence';e.mkdir();facts={'bootIdSha256':'a'*64,'adbdPid':101,'adbdStartTicks':'20'}
  initial={'initialSyntheticWifi':{'enabled':True,'connectedRowCount':1,'exactKnownNetworkConnected':True},'schema':1,'sourceHead':HEAD,'result':'OBSERVED','sameGuestTcpBinding':True,'wifiNotDisabledAfterBinding':True,'mobileDataGlobalSettingZero':True,'connectAttempts':1,'ipv4RouteIsolation':{'extraEgressRoutes':0},'originalRouteGuest':facts,'selectedRouteGuest':facts,'effectiveNetworkOptions':{'ready':True,'radioArgumentMatches':1,'wifiArgumentMatches':1,'expectedRadioArgument':'user,id=mynet,restrict=on','expectedWifiArgument':'user,id=virtio-wifi,restrict=on,dhcpstart=10.0.2.16,hostfwd=tcp:127.0.0.1:12346-10.0.2.16:5555'}}
  M.save(e/'owned-wifi-route-initial.json',initial);prior=None;rows=[]
  for n,phase in enumerate(['initial','root'] if mode=='core' else ['initial','root','reboot','root']):
   if phase=='reboot':facts={**facts,'bootIdSha256':'b'*64,'adbdPid':201}
   elif phase=='root':facts={**facts,'adbdPid':facts['adbdPid']+1}
   row={'schema':1,'sourceHead':HEAD,'phase':phase,'guest':facts,'originalRouteGuest':facts,'selectedRouteGuest':facts,'priorGuest':prior,'target':'127.0.0.1:12346','originalSerial':'emulator-5584','emulatorPid':777,'loopbackListenerOwned':True,'sameGuestIndependentCommands':True,'authConfigurationUnchanged':True,'responseRouteProof':{'adbdUid':0,'guestResponseRouteReadiness':{'ready':True,'last':{'ready':True,'state':'WLAN0_ROUTE','uid':0}}}}
   if phase=='reboot':
    row['responseRouteProof']={'method':'INCOMING_TCP_SAME_GUEST','adbdUid':2000,'connectResponse':'connected to 127.0.0.1:12346','connectCapMs':12000,'connectElapsedMs':100,'remainingPhaseBudgetBeforeConnectMs':200000,'phaseDeadlineMet':True,'remainingPhaseBudgetBeforeSaveMs':199000,
     'incomingResponse':{'guest':facts,'adbdUid':2000,'stdoutBytes':200,'stdoutSha256':'c'*64,'framing':'COMPLETE_GUEST_AND_BOUND_UID'},
     'listener':{'pid':777,'address':'127.0.0.1:12346','ready':True,'onlyExpectedPid':True,'onlyExpectedLoopbackAddress':True,'processRecords':1,'descriptorRecords':1,'addressRecords':1,'unknownFields':0},
     'wifiBackend':{'hostPort':12346,'radioOptions':'restrict=on','wifiOptions':'restrict=on,dhcpstart=10.0.2.16,hostfwd=tcp:127.0.0.1:12346-10.0.2.16:5555'},
     'originalBootCompleted':{'valueClass':'ONE','stdoutBytes':1,'stdoutSha256':hashlib.sha256(b'1').hexdigest()},'selectedBootCompleted':{'valueClass':'ONE','stdoutBytes':1,'stdoutSha256':hashlib.sha256(b'1').hexdigest()}}
   path=e/f'owned-tcp-adb-{phase}-{n+1}.json';M.save(path,row);rows.append((path,row));prior=facts
  if mode=='full':
   M.save(e/'owned-tcp-reboot-request.json',{'schema':1,'sourceHead':HEAD,'result':'PASS','scope':'REBOOT_REQUEST_NOT_REBOOT_PROOF','method':'BOUND_ORIGINAL_EMULATOR_AFTER_SCOPED_TCP_DISCONNECT','requestCount':1,'disconnectCount':1,'selectedTransportRemoved':True,'requestExitCode':0,'stdoutBytes':0,'stderrBytes':0,'requestElapsedMs':100,'requestCapMs':30000,'remainingPhaseBudgetBeforeRequestMs':239000,'originalSerial':'emulator-5584','selectedTcpTarget':'127.0.0.1:12346','emulatorPid':777,'matchedRetainedGuest':True,'originalRouteGuest':rows[2][1]['priorGuest'],'selectedRouteGuest':rows[2][1]['priorGuest']})
  if mode=='full':
   reboot=rows[2][1];restoration={'method':'ONE_KNOWN_SYNTHETIC_WIFI_CONNECT_AFTER_USER_UNLOCK','sourceHead':HEAD,'result':'REQUEST_COMPLETED','requestCount':1,'userState':'RUNNING_UNLOCKED','initialBootIdSha256':initial['originalRouteGuest']['bootIdSha256'],'priorBootIdSha256':reboot['priorGuest']['bootIdSha256'],'responseClass':'EMPTY','connectionEstablishedByResponse':False,'requestCapMs':30000,'requestElapsedMs':100,'remainingPhaseBudgetBeforeRequestMs':230000}
   last={'result':'ATTACHED','priorGuest':reboot['priorGuest'],'originalGuest':reboot['guest'],'selectedGuest':reboot['guest'],'routeProof':reboot['responseRouteProof'],'wifiRestoration':restoration}
   M.save(e/'owned-reboot-reattachment-observation.json',{'schema':1,'sourceHead':HEAD,'phase':'reboot','terminal':'REATTACHED','priorGuest':reboot['priorGuest'],'stages':{'attached':{'count':1,'first':last,'last':last}}})
  return initial,rows
 def test_core_and_full_admit_only_persisted_expected_phase_sequence(self):
  for mode,count in [('core',2),('full',4)]:
   with tempfile.TemporaryDirectory() as d:
    run=Path(d).resolve();self.fixture(run,mode);proof=M.isolated_tcp_evidence(run,HEAD,mode)
    self.assertEqual(proof['result'],'PASS');self.assertEqual(len(proof['files']),count+1+2*(mode=='full'))
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
   for key,value in [('mobileDataGlobalSettingZero',False),('ipv4RouteIsolation',{'extraEgressRoutes':1}),('effectiveNetworkOptions',{}),('connectAttempts',2),('initialSyntheticWifi',{}),('initialSyntheticWifi',{'enabled':True,'connectedRowCount':1,'exactKnownNetworkConnected':False})]:
    p.unlink();M.save(p,initial|{key:value})
    with self.subTest(key=key),self.assertRaises(M.StageFailure):M.isolated_tcp_evidence(run,HEAD,'core')
 def test_root_receipt_must_prove_actual_zero_uid(self):
  with tempfile.TemporaryDirectory() as d:
   run=Path(d).resolve();_,rows=self.fixture(run,'core');path,row=rows[-1];route=copy.deepcopy(row['responseRouteProof']);route['adbdUid']=2000;route['guestResponseRouteReadiness']['last']['uid']=2000;path.unlink();M.save(path,row|{'responseRouteProof':route})
   with self.assertRaises(M.StageFailure):M.isolated_tcp_evidence(run,HEAD,'core')
 def test_full_requires_exact_successful_reboot_request_witness_after_cleanup(self):
  with tempfile.TemporaryDirectory() as d:
   run=Path(d).resolve();self.fixture(run,'full');path=run/'evidence/owned-tcp-reboot-request.json';raw=path.read_bytes();request=__import__('json').loads(raw);path.unlink()
   with self.assertRaises(M.StageFailure):M.isolated_tcp_evidence(run,HEAD,'full')
   for change in [{'sourceHead':'b'*40},{'method':'TCP_FALLBACK'},{'requestCount':2},{'disconnectCount':0},{'selectedTransportRemoved':False},{'requestExitCode':1},{'requestElapsedMs':30000},{'remainingPhaseBudgetBeforeRequestMs':50},{'originalSerial':'emulator-5582'},{'selectedTcpTarget':'127.0.0.1:12347'},{'originalRouteGuest':{}},{'result':'FAIL'}]:
    if path.exists():path.unlink()
    M.save(path,request|change)
    with self.subTest(change=change),self.assertRaises(M.StageFailure):M.isolated_tcp_evidence(run,HEAD,'full')
   path.unlink();M.save(path,request);self.assertEqual(M.isolated_tcp_evidence(run,HEAD,'full')['result'],'PASS')
 def test_full_requires_bound_single_wifi_restoration_after_cleanup(self):
  with tempfile.TemporaryDirectory() as d:
   run=Path(d).resolve();self.fixture(run,'full');path=run/'evidence/owned-reboot-reattachment-observation.json';raw=path.read_bytes();observation=__import__('json').loads(raw);path.unlink()
   with self.assertRaises(M.StageFailure):M.isolated_tcp_evidence(run,HEAD,'full')
   for change in [{'sourceHead':'b'*40},{'result':'FAILED'},{'method':'AUTOMATIC_FALLBACK'},{'requestCount':2},{'userState':'RUNNING_UNLOCKING'},{'initialBootIdSha256':'c'*64},{'priorBootIdSha256':'c'*64},{'responseClass':'REFUSED'},{'connectionEstablishedByResponse':True},{'requestElapsedMs':30000},{'remainingPhaseBudgetBeforeRequestMs':1}]:
    row=copy.deepcopy(observation);row['stages']['attached']['last']['wifiRestoration'].update(change)
    if path.exists():path.unlink()
    M.save(path,row)
    with self.subTest(change=change),self.assertRaises(M.StageFailure):M.isolated_tcp_evidence(run,HEAD,'full')
   for change in [{'terminal':'FAILED'},{'priorGuest':{}},{'sourceHead':'b'*40}]:
    path.unlink();M.save(path,observation|change)
    with self.subTest(change=change),self.assertRaises(M.StageFailure):M.isolated_tcp_evidence(run,HEAD,'full')
   for change in [{'count':2},{'last':{}}]:
    row=copy.deepcopy(observation);row['stages']['attached'].update(change);path.unlink();M.save(path,row)
    with self.assertRaises(M.StageFailure):M.isolated_tcp_evidence(run,HEAD,'full')
   path.unlink();M.save(path,observation);self.assertEqual(M.isolated_tcp_evidence(run,HEAD,'full')['result'],'PASS')
 def test_final_hash_equality_detects_changed_persisted_witness(self):
  with tempfile.TemporaryDirectory() as d:
   run=Path(d).resolve();_,rows=self.fixture(run,'core');before=M.isolated_tcp_evidence(run,HEAD,'core');p,row=rows[-1];p.unlink();M.save(p,row|{'additionalSafeFact':True});after=M.isolated_tcp_evidence(run,HEAD,'core');self.assertNotEqual(before,after)
   source=(B/'mobile-acceptance.py').read_text();self.assertIn("require(private_json(attempt/'evidence/isolated-tcp-admission.json')==isolated_tcp_evidence",source)
   self.assertIn("save(args.attempt/'evidence/isolated-tcp-admission.json',isolated_tcp_evidence",source)
 def test_reboot_requires_actual_frame_uid_listener_boot_and_deadline_after_cleanup(self):
  changes=[('method','MARK_ZERO_ONLY'),('connectResponse',None),('incomingResponse',{}),('incomingResponse.adbdUid',0),('incomingResponse.guest',{}),('incomingResponse.stdoutBytes',0),('incomingResponse.stdoutSha256',None),('incomingResponse.framing','PARTIAL'),('listener.pid',778),('listener.address','0.0.0.0:12346'),('listener.ready',False),('listener.onlyExpectedPid',False),('listener.descriptorRecords',2),('wifiBackend',{}),('originalBootCompleted',{}),('selectedBootCompleted.valueClass','ZERO'),('selectedBootCompleted.stdoutSha256','a'*64),('phaseDeadlineMet',False),('connectElapsedMs',12000),('remainingPhaseBudgetBeforeConnectMs',50),('remainingPhaseBudgetBeforeSaveMs',0)]
  with tempfile.TemporaryDirectory() as d:
   run=Path(d).resolve();_,rows=self.fixture(run,'full');path,row=rows[2];original=copy.deepcopy(row);observation=run/'evidence/owned-reboot-reattachment-observation.json';base=M.private_json(observation)
   for field,value in changes:
    changed=copy.deepcopy(original);dest=changed['responseRouteProof'];parts=field.split('.')
    for part in parts[:-1]:dest=dest[part]
    dest[parts[-1]]=value;path.unlink();M.save(path,changed)
    # Bind the mutated proof in both retained locations, so rejection tests
    # the required fact rather than a trivial cross-receipt mismatch.
    capture=copy.deepcopy(base);capture['stages']['attached']['last']['routeProof']=changed['responseRouteProof'];observation.unlink();M.save(observation,capture)
    with self.subTest(field=field),self.assertRaises(M.StageFailure):M.isolated_tcp_evidence(run,HEAD,'full')
   path.unlink();M.save(path,original);observation.unlink();M.save(observation,base);self.assertEqual(M.isolated_tcp_evidence(run,HEAD,'full')['result'],'PASS')

if __name__=='__main__':unittest.main()
