"""Focused mobile peer provisioning/control tests; no Obsidian/device launch."""
import http.server
import importlib.util
import json
import os
from pathlib import Path
import ssl
import subprocess
import sys
import tempfile
import threading
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import urllib.error
import urllib.request

SPEC=importlib.util.spec_from_file_location('mobile_session',Path(__file__).with_name('mobile-session.py'))
M=importlib.util.module_from_spec(SPEC);SPEC.loader.exec_module(M)


class Configuration(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(prefix='obsync-mobile-config-');self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name).resolve();self.source=self.root/'source';self.run=self.root/'new-run'
        paths={'serverBinary':self.root/'server','node':self.root/'node',
            'obsidianExecutable':self.root/'official/Obsidian.app/Contents/MacOS/Obsidian',
            'obsidianAsar':self.root/'official/Obsidian.app/Contents/Resources/app.asar',
            'tlsScript':self.root/'driver/scripts/validation/mobile-tls.mjs'}
        for path in [*paths.values(),self.source/'scripts/ci/observer.mjs',self.source/'dashboard/index.html',*[self.source/'plugin/dist'/n for n in M.PLUGIN]]:
            path.parent.mkdir(parents=True,exist_ok=True);path.write_bytes(('synthetic '+path.name).encode())
        self.config={'schema':1,'source':str(self.source),'sourceHead':'a'*40,
            **{k:str(v) for k,v in paths.items()},
            'serverSha256':M.COMMON.digest(paths['serverBinary']),'nodeSha256':M.COMMON.digest(paths['node']),
            'obsidianSha256':M.COMMON.digest(paths['obsidianExecutable']),'obsidianAsarSha256':M.COMMON.digest(paths['obsidianAsar']),
            'tlsScriptSha256':M.COMMON.digest(paths['tlsScript']),'observerSha256':M.COMMON.digest(self.source/'scripts/ci/observer.mjs'),
            'pluginHashes':{n:M.COMMON.digest(self.source/'plugin/dist'/n) for n in M.PLUGIN}}
        self.path=self.root/'config.json'

    def load(self):
        self.path.write_text(json.dumps(self.config));self.path.chmod(0o600)
        def git(argv,**kwargs):
            if argv[-1]=='HEAD':return 'a'*40+'\n'
            if argv[-1]=='--git-common-dir':return str(self.source/'.git')+'\n'
            return b''
        class Port:
            def __enter__(self):return self
            def __exit__(self,*_):pass
            def bind(self,address):self.address=address
        with patch.object(M.subprocess,'check_output',side_effect=git),patch.object(M.socket,'socket',return_value=Port()):
            return M.configuration(self.path,self.run)

    def test_exact_pins_and_default_budget_without_creating_run(self):
        c=self.load();self.assertEqual(c['seconds'],14400);self.assertEqual(c['tlsPort'],18473)
        self.assertEqual(c['mode'],'acceptance')
        self.assertFalse(self.run.exists())

    def test_core_mode_is_explicit_and_unknown_mode_refuses(self):
        self.config['mode']='core';self.assertEqual(self.load()['mode'],'core')
        self.config['mode']='skip-security'
        with self.assertRaisesRegex(ValueError,'core or acceptance'):self.load()

    def test_changed_application_javascript_refuses(self):
        Path(self.config['obsidianAsar']).write_bytes(b'tampered application JS')
        with self.assertRaisesRegex(ValueError,'pinned artifact differs'):self.load()
        self.assertFalse(self.run.exists())

    def test_existing_run_preserved_and_foreign_asar_refuses(self):
        self.run.mkdir();(self.run/'sentinel').write_text('keep')
        with self.assertRaisesRegex(ValueError,'fresh absent run'):self.load()
        self.assertEqual((self.run/'sentinel').read_text(),'keep')
        self.run=self.root/'another';self.config['obsidianAsar']=str(self.root/'foreign/app.asar')
        with self.assertRaisesRegex(ValueError,'belong to the pinned application'):self.load()

    def test_wrong_source_and_unbounded_or_public_ports_refuse(self):
        for field,value,reason in [('sourceHead','b'*40,'clean candidate'),('seconds',0,'duration'),('tlsPort',443,'local TLS port')]:
            previous=self.config.get(field);self.config[field]=value
            with self.subTest(field=field),self.assertRaisesRegex(ValueError,reason):self.load()
            if previous is None:self.config.pop(field)
            else:self.config[field]=previous


class StartupCleanup(unittest.TestCase):
    setUp=Configuration.setUp
    load=Configuration.load
    def exercise_failure(self,cleanup_failure=False):
        c=self.load();calls=[]
        class Owner:
            def __init__(self,run,state):self.run=run;self.state=state
            def launch(self,name,argv,env=None):
                calls.append(('launch',name))
                (self.run/'private/server.log').write_text('Error: startup sentinel\nAuthorization: omit-this-value\n')
                self.state['processes'][name]={'pid':321,'identity':'synthetic','argv':argv}
                M.COMMON.save(self.run/'lab.json',self.state)
                return SimpleNamespace(pid=321)
            def stop(self):
                calls.append(('stop',))
                if cleanup_failure:raise RuntimeError('synthetic group remains')
        with patch.object(M,'Peers',Owner),patch.object(M.COMMON,'identity',return_value='synthetic-holder'), \
             patch.object(M.COMMON,'free_port',side_effect=[12345,12346]), \
             patch.object(M,'wait_http',side_effect=RuntimeError('startup sentinel')):
            with self.assertRaises(RuntimeError):M.execute(c,self.run,['synthetic-child'])
        result=json.loads((self.run/'evidence/peer-result.json').read_text())
        self.assertEqual(result['result'],'FAIL');self.assertEqual(result['failure']['stage'],'server')
        self.assertIn(('stop',),calls)
        diagnostic=(self.run/'evidence/startup-failure.json').read_text()
        self.assertIn('startup sentinel',diagnostic);self.assertNotIn('omit-this-value',diagnostic)
        return result

    def test_startup_failure_cleans_only_owned_fixture_and_keeps_sanitized_receipt(self):
        result=self.exercise_failure()
        self.assertEqual(result['cleanup'],'PASS')
        self.assertTrue(result['runtimeAbsent'] and result['privateAbsent'] and result['manifestAbsent'])

    def test_unproven_group_absence_preserves_owned_profile_and_manifest(self):
        result=self.exercise_failure(cleanup_failure=True)
        self.assertEqual(result['cleanup'],'FAIL')
        self.assertFalse(result['runtimeAbsent'] or result['privateAbsent'] or result['manifestAbsent'])

    def test_incomplete_nested_android_cleanup_preserves_peer_profile(self):
        nested=self.root/'android/evidence';nested.mkdir(parents=True)
        M.COMMON.save(nested/'result.json',{'cleanup':'FAIL','ownedGroupsRemaining':1})
        result=self.exercise_failure()
        self.assertEqual(result['cleanup'],'FAIL')
        self.assertFalse(result['runtimeAbsent'] or result['privateAbsent'] or result['manifestAbsent'])


class Certificates(unittest.TestCase):
    def test_real_certificates_pass_strict_tls_and_reject_wrong_hostname(self):
        with tempfile.TemporaryDirectory(prefix='obsync-mobile-tls-') as tmp:
            root=Path(tmp).resolve();M.certificates(root)
            leaf=subprocess.check_output(['openssl','x509','-in',str(root/'tls.crt'),'-noout','-text'],text=True)
            self.assertIn('Subject Key Identifier',leaf);self.assertIn('Authority Key Identifier',leaf)
            class Handler(http.server.BaseHTTPRequestHandler):
                def do_GET(self):
                    self.send_response(200);self.end_headers();self.wfile.write(b'fixture')
                def log_message(self,*_):pass
            server=http.server.HTTPServer(('127.0.0.1',0),Handler)
            context=ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER);context.load_cert_chain(root/'tls.crt',root/'tls.key')
            server.socket=context.wrap_socket(server.socket,server_side=True)
            thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
            try:
                client=ssl.create_default_context(cafile=str(root/'ca.crt'));client.verify_flags|=ssl.VERIFY_X509_STRICT
                with urllib.request.urlopen('https://localhost:'+str(server.server_port),context=client,timeout=3) as response:
                    self.assertEqual(response.status,200);self.assertEqual(response.read(),b'fixture')
                with self.assertRaises(urllib.error.URLError) as failure:
                    urllib.request.urlopen('https://127.0.0.1:'+str(server.server_port),context=client,timeout=3)
                self.assertIsInstance(failure.exception.reason,ssl.SSLCertVerificationError)
                self.assertEqual(failure.exception.reason.verify_code,64)
            finally:server.shutdown();server.server_close();thread.join(timeout=3)


class Evidence(unittest.TestCase):
    def test_complete_capture_and_scan_hash_binding_without_raw_traffic(self):
        with tempfile.TemporaryDirectory(prefix='obsync-mobile-scan-') as tmp:
            run=Path(tmp).resolve();traffic=run/'private/traffic';traffic.mkdir(parents=True);(run/'evidence').mkdir()
            M.COMMON.save(traffic/'complete.json',{'version':1,'connections':1,'errors':[]})
            (traffic/'c1.up').write_bytes(b'PRIVATE_SENTINEL');(traffic/'index.jsonl').write_text('{}\n')
            c={'sourceHead':'a'*40,'observerSha256':'b'*64}
            complete,digest=M.capture_manifest(run,c)
            self.assertEqual(complete['connections'],1)
            M.COMMON.save(traffic/'complete.json',{'connections':1})
            with self.assertRaisesRegex(ValueError,'completion schema'):M.capture_manifest(run,c)
            M.COMMON.save(traffic/'complete.json',complete)
            self.assertNotIn('PRIVATE_SENTINEL',(run/'evidence/traffic-manifest.json').read_text())
            common={'schema':1,'result':'PASS','sourceHead':'a'*40,'observerSha256':'b'*64,
                'captureManifestSha256':digest,'opaqueScannerSha256':'c'*64}
            scan=common|{'origin':'native-confidentiality','notes':3,'backups':3,'nativeCaptures':3,'pairingCodes':1,'metadataExports':1,
                'contentNeedles':11,'trafficConnections':1,'trafficRequests':1,'trafficBytes':50,'serverStorageFiles':4,
                'serverLogBytes':5,'scannedBytes':100,'scannedFiles':8,'unexpectedHits':0,'parseErrors':0,
                'knownRootDerivedKeyCoverageOnly':True,'rawApiCredentialValueScan':'NOT_MEASURED','apiCredentialTrafficSinks':'NOT_ASSESSED',
                'durationMs':100,'budgetMs':60000}
            controls=common|{'origin':'detached-scanner-controls','baselinePassed':True,'parseableClonedHttpLeakDetected':True,
                'copiedServerStorageLeakDetected':True,'copiedServerLogLeakDetected':True,'nativeCaptureUnchanged':True,
                'serverSnapshotUnchanged':True,'scratchCleanup':'VERIFIED'}
            receipts=['evidence/native-confidentiality.json','evidence/native-confidentiality-controls.json']
            proof=common|{'receipts':receipts};M.COMMON.save(run/'private/scan-result.json',proof)
            M.COMMON.save(run/receipts[0],scan);M.COMMON.save(run/receipts[1],controls);M.scan_manifest(run,c)
            manifest=json.loads((run/'evidence/scan-manifest.json').read_text())
            self.assertEqual(manifest['receipts'][receipts[0]],M.COMMON.digest(run/receipts[0]))
            for name,original in zip(receipts,(scan,controls)):
                for key,value in original.items():
                    missing={k:v for k,v in original.items() if k!=key}
                    M.COMMON.save(run/name,missing)
                    with self.assertRaises(ValueError,msg=name+':missing:'+key):M.scan_manifest(run,c)
                    M.COMMON.save(run/name,original)
                for key,value in [('result','FAIL'),('sourceHead','d'*40),('observerSha256','d'*64),('captureManifestSha256','d'*64),('opaqueScannerSha256','invalid')]:
                    M.COMMON.save(run/name,original|{key:value})
                    with self.assertRaises(ValueError,msg=name+':contradict:'+key):M.scan_manifest(run,c)
                    M.COMMON.save(run/name,original)
            for name,original,key,value in [(receipts[0],scan,'unexpectedHits',1),(receipts[0],scan,'nativeCaptures',2),
                (receipts[0],scan,'parseErrors',False),(receipts[0],scan,'durationMs',60001),
                (receipts[0],scan,'rawApiCredentialValueScan','PASS'),(receipts[1],controls,'baselinePassed',False),
                (receipts[1],controls,'parseableClonedHttpLeakDetected',False),(receipts[1],controls,'opaqueScannerSha256','d'*64)]:
                M.COMMON.save(run/name,original|{key:value})
                with self.assertRaises(ValueError):M.scan_manifest(run,c)
                M.COMMON.save(run/name,original)
            for broken in ([],[receipts[0]],receipts[::-1],['evidence/contradiction.json']):
                M.COMMON.save(run/'evidence/contradiction.json',{'result':'FAIL','sourceHead':'d'*40})
                M.COMMON.save(run/'private/scan-result.json',proof|{'receipts':broken})
                with self.assertRaises(ValueError):M.scan_manifest(run,c)
            M.COMMON.save(run/'private/scan-result.json',proof)
            proof['captureManifestSha256']='0'*64;M.COMMON.save(run/'private/scan-result.json',proof)
            with self.assertRaisesRegex(ValueError,'exact-source observer scan'):M.scan_manifest(run,c)

    def test_requests_require_private_schema_and_stable_identifier(self):
        with tempfile.TemporaryDirectory(prefix='obsync-mobile-request-') as tmp:
            run=Path(tmp).resolve();(run/'private').mkdir();path=run/'private/restart.json'
            self.assertIsNone(M.request(run,'restart.json'))
            M.COMMON.save(path,{'schema':1,'requestId':'R1','device':'A'})
            self.assertEqual(M.request(run,'restart.json')['requestId'],'R1')
            path.chmod(0o644)
            with self.assertRaisesRegex(ValueError,'owned private'):M.request(run,'restart.json')
            M.COMMON.save(path,{'schema':1,'requestId':'../bad','device':'A'})
            with self.assertRaisesRegex(ValueError,'schema refused'):M.request(run,'restart.json')

    def test_owned_peer_restart_reaps_old_group_before_replacement(self):
        with tempfile.TemporaryDirectory(prefix='obsync-mobile-owner-') as tmp:
            run=Path(tmp).resolve();(run/'private').mkdir();state={'processes':{}}
            owner=M.Peers(run,state)
            first=owner.launch('A',[sys.executable,'-c','import time; time.sleep(60)'])
            old=first.pid
            try:
                owner.stop_one('A');self.assertEqual(M.COMMON.group_members(old),[])
                second=owner.launch('A',[sys.executable,'-c','import time; time.sleep(60)'])
                self.assertNotEqual(second.pid,old)
                self.assertEqual(json.loads((run/'lab.json').read_text())['processes']['A']['pid'],second.pid)
                self.assertFalse((run/'android.json').exists())
            finally:owner.stop()


if __name__=='__main__':unittest.main()
