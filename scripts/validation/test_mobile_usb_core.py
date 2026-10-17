"""USB core dispatch and explicit TLS inputs; no device/network/app calls."""
import contextlib
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import ssl
import subprocess
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

def load(name):
    spec=importlib.util.spec_from_file_location(name,Path(__file__).with_name(name+'.py'))
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module
R=load('mobile-acceptance');T=load('mobile-trusted-tls');P=load('android-tls-proof')


def config():
    return {'schema':1,'sourceHead':'a'*40,'source':'/clean/source','node':'/pinned/node','tlsPort':18473,
        'trustedTls':{'hostname':'owner-provided.example','certificate':'/explicit/cert','certificateSha256':'b'*64,'key':'/explicit/key','keySha256':'c'*64},'android':{'targetKind':'usb','ownerApprovedDedicatedFixture':True,
        'sourceHead':'a'*40,'serial':'OWNER_SUPPLIED','vaultPath':'/storage/emulated/0/Documents/Obsync-USB-Test',
        'trustedRoute':{'transport':'adb-reverse','url':'https://owner-provided.example:18473'}}}


class Scope(unittest.TestCase):
    def test_usb_full_and_repeated_fixture_never_pass_core_scope(self):
        self.assertEqual(R.target_scope(config(),'core',1),'usb')
        for mode,runs in (('full',1),('full',3),('core',3)):
            with self.assertRaises(R.StageFailure):R.target_scope(config(),mode,runs)
        for mutate in (lambda c:c.pop('trustedTls'),lambda c:c['android'].update(ownerApprovedDedicatedFixture=False),lambda c:c['android']['trustedRoute'].update(url='https://foreign.example:18473'),lambda c:c['android']['trustedRoute'].update(transport='direct')):
            value=config();mutate(value)
            with self.assertRaises(R.StageFailure):R.target_scope(value,'core',1)
        rows=[{'attempt':str(i),'result':'FULL_PASS','cleanup':'PASS'} for i in range(3)]
        summary=R.summary(rows,3,'full','a'*40,'usb')
        self.assertEqual(summary['result'],'FAIL');self.assertFalse(summary['threeFreshFullRunsPassed']);self.assertEqual(summary['fullAcceptance'],'NOT_RUN')

    def test_dispatch_needs_no_emulator_java_image_or_assets_and_reports_core_only(self):
        with tempfile.TemporaryDirectory(prefix='obsync-usb-core-') as tmp:
            attempt=Path(tmp).resolve();desktop=attempt/'desktop';android=attempt/'android'
            for path in (attempt/'private',desktop/'evidence',android/'evidence'):path.mkdir(parents=True)
            calls=[]
            class Steps:
                def run(self,*args,**kwargs):calls.append(args);return {'result':'PASS'}
            def run(argv,**kwargs):
                self.assertIn('android-usb.py',' '.join(argv));self.assertIn('--child',argv)
                self.assertNotIn('--java',argv);self.assertNotIn('--assets',argv)
                R.save(android/'evidence/result.json',{'result':'PASS','sourceHead':'a'*40,'cleanup':'PASS','ownedGroupsRemaining':0,
                    'runtimeAbsent':True,'privateAbsent':True,'manifestAbsent':True})
                return SimpleNamespace(returncode=0)
            args=SimpleNamespace(attempt=attempt,config=attempt/'input.json',mode='core')
            with patch.object(R,'child_context',return_value=(config(),desktop,android,{},Steps())),patch.object(R,'usb_configuration',return_value={'targetKind':'usb'}),patch.object(R,'helper',side_effect=lambda name:'/helpers/'+name),patch.object(R.subprocess,'run',side_effect=run),patch.object(R,'lifecycle_request'),contextlib.redirect_stdout(io.StringIO()):R.desktop_child(args)
            proof=json.loads((desktop/'evidence/core-result.json').read_text())
            self.assertEqual(proof['result'],'CORE_ONLY');self.assertEqual(proof['physicalPhone'],'USB_CORE_ONLY');self.assertEqual(proof['fullAcceptance'],'NOT_RUN')

    def test_runtime_route_binding_uses_owned_leaf_and_exact_supplied_hostname(self):
        with tempfile.TemporaryDirectory(prefix='obsync-usb-bind-') as tmp:
            desktop=Path(tmp).resolve();(desktop/'private').mkdir();(desktop/'private/tls-binding.json').write_text('{}')
            pem='-----BEGIN CERTIFICATE-----\nQQ==\n-----END CERTIFICATE-----\n';(desktop/'private/tls.crt').write_text(pem+pem)
            c=config();lab={'mobileUrl':c['android']['trustedRoute']['url']}
            value=R.usb_configuration(c,desktop,lab)
            self.assertEqual(value['trustedRoute']['leafDerSha256'],hashlib.sha256(b'A').hexdigest())
            with self.assertRaises(R.StageFailure):R.usb_configuration(c,desktop,{'mobileUrl':'https://foreign.example:18473'})


class Materials(unittest.TestCase):
    def test_real_ssl_keypair_check_is_noninteractive_and_rejects_wrong_key(self):
        with tempfile.TemporaryDirectory(prefix='obsync-tls-pair-unit-') as tmp:
            root=Path(tmp).resolve()
            for label in ('one','two'):
                subprocess.run(['openssl','req','-x509','-newkey','rsa:2048','-nodes','-days','1','-keyout',str(root/(label+'.key')),
                    '-out',str(root/(label+'.crt')),'-subj','/CN=offline-unit.example'],check=True,capture_output=True,timeout=20)
                (root/(label+'.key')).chmod(0o600)
            c={'hostname':'offline-unit.example','certificate':str(root/'one.crt'),'certificateSha256':hashlib.sha256((root/'one.crt').read_bytes()).hexdigest(),
               'key':str(root/'one.key'),'keySha256':hashlib.sha256((root/'one.key').read_bytes()).hexdigest()}
            self.assertEqual(T.validate(c)['hostname'],'offline-unit.example')
            with self.assertRaises(ssl.SSLError):T.validate(c|{'key':str(root/'two.key'),'keySha256':hashlib.sha256((root/'two.key').read_bytes()).hexdigest()})

    def test_pins_private_key_custody_pair_validation_and_full_chain_leaf(self):
        with tempfile.TemporaryDirectory(prefix='obsync-trusted-tls-') as tmp:
            root=Path(tmp).resolve();cert=root/'cert.pem';key=root/'key.pem';private=root/'private';private.mkdir()
            pem='-----BEGIN CERTIFICATE-----\nQQ==\n-----END CERTIFICATE-----\n'
            cert.write_text(pem+pem);key.write_text('private-key-only-test-fixture');key.chmod(0o600)
            c={'hostname':'owner-provided.example','certificate':str(cert),'certificateSha256':hashlib.sha256(cert.read_bytes()).hexdigest(),
               'key':str(key),'keySha256':hashlib.sha256(key.read_bytes()).hexdigest()}
            context=SimpleNamespace(load_cert_chain=lambda *args,**kwargs:None)
            with patch.object(T.ssl,'SSLContext',return_value=context),patch.object(T.socket,'getaddrinfo',return_value=[(None,None,None,None,('127.0.0.1',0))]):
                result=T.stage(private,c)
            self.assertEqual(result['leafDerSha256'],hashlib.sha256(b'A').hexdigest());self.assertFalse(result['hostTrustChanged'])
            self.assertNotIn(key.read_text(),json.dumps(result));self.assertEqual((private/'tls.key').stat().st_mode&0o777,0o600)
            for mutate in (lambda:key.chmod(0o644),lambda:key.write_text('changed')):
                mutate()
                with self.assertRaises(ValueError):T.validate(c)
                key.chmod(0o600)
            with self.assertRaises(ValueError):T.leaf_der(pem+'PRIVATE EXTRA MATERIAL')

    def test_nonloopback_dns_and_bad_host_proof_never_become_pass(self):
        self.assertTrue(P.strict_host_proof({'result':'PASS','validHostnameAccepted':True,'wrongHostnameRejected':True,'trustBasis':'SYSTEM_DEFAULT','leafSha256':'a'*64}))
        for change in ({'trustBasis':'UNKNOWN'},{'leafSha256':'x'},{'wrongHostnameRejected':False},{'result':'UNKNOWN'}):
            self.assertFalse(P.strict_host_proof({'result':'PASS','validHostnameAccepted':True,'wrongHostnameRejected':True,'trustBasis':'SYSTEM_DEFAULT','leafSha256':'a'*64}|change))
        with tempfile.TemporaryDirectory(prefix='obsync-trusted-tls-dns-') as tmp:
            private=Path(tmp).resolve();c={'hostname':'owner-provided.example','certificate':'cert','certificateSha256':'a'*64,'key':'key','keySha256':'b'*64}
            pem=b'-----BEGIN CERTIFICATE-----\nQQ==\n-----END CERTIFICATE-----\n'
            with patch.object(T,'validate',return_value=c),patch.object(T,'artifact',side_effect=[(None,pem),(None,b'private')]),patch.object(T.ssl,'SSLContext',return_value=SimpleNamespace(load_cert_chain=lambda *args,**kwargs:None)),patch.object(T.socket,'getaddrinfo',return_value=[(None,None,None,None,('192.0.2.1',0))]):
                with self.assertRaisesRegex(ValueError,'already resolve'):T.stage(private,c)


if __name__=='__main__':unittest.main()
