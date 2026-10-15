"""Synthetic-CA safety and orchestration tests; no device actions."""
import importlib.util
import json
from pathlib import Path
import shlex
import subprocess
import tempfile
import unittest
from unittest.mock import patch

SPEC=importlib.util.spec_from_file_location('android_trust',Path(__file__).with_name('android-trust.py'))
M=importlib.util.module_from_spec(SPEC);SPEC.loader.exec_module(M)


class Certificates(unittest.TestCase):
    def test_actual_one_day_ca_pin_and_old_subject_hash(self):
        with tempfile.TemporaryDirectory(prefix='obsync-ca-test-') as tmp:
            root=Path(tmp); ca=root/'ca.crt'
            subprocess.run(['openssl','req','-x509','-newkey','rsa:2048','-nodes','-days','1',
                '-keyout',str(root/'synthetic.key'),'-out',str(ca),'-subj','/CN=Disposable Android Test',
                '-addext','basicConstraints=critical,CA:TRUE','-addext','keyUsage=critical,keyCertSign,cRLSign'],
                stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,check=True)
            proof=M.cert_info(ca,M.SESSION.digest(ca))
            self.assertRegex(proof['name'],r'^[0-9a-f]{8}\.0$')
            with self.assertRaisesRegex(ValueError,'SHA-256 mismatch'): M.cert_info(ca,'0'*64)
            real=subprocess.check_output
            def dates(argv,**kwargs):
                if '-startdate' in argv: return 'notBefore=Oct 15 00:00:00 2026 GMT\nnotAfter=Oct 18 00:00:00 2026 GMT\n'
                return real(argv,**kwargs)
            with patch.object(M.subprocess,'check_output',side_effect=dates):
                with self.assertRaisesRegex(ValueError,'one-day lifetime'): M.cert_info(ca,M.SESSION.digest(ca))

    def test_pretrust_receipt_requires_actual_rejection_and_exact_source(self):
        with tempfile.TemporaryDirectory(prefix='obsync-ca-proof-') as tmp:
            path=Path(tmp)/'proof.json'
            proof={'result':'PASS','untrustedRejected':True,'sourceHead':'a'*40}
            path.write_text(json.dumps(proof)); self.assertEqual(M.untrusted_receipt(path,'a'*40),M.SESSION.digest(path))
            for change in ({'result':'READY'},{'untrustedRejected':False},{'sourceHead':'b'*40}):
                path.write_text(json.dumps(proof|change))
                with self.assertRaisesRegex(ValueError,'untrusted WebView rejection'): M.untrusted_receipt(path,'a'*40)


class Control(unittest.TestCase):
    def test_inventory_quotes_remote_script_and_rejects_empty_or_bad_entries(self):
        row='a'*64+' '+M.STORE+'/1234abcd.0\n'
        with patch.object(M,'shell',return_value=row) as call:
            self.assertEqual(M.inventory({},321),{'1234abcd.0':'a'*64})
        self.assertEqual(call.call_args.args,({},'toybox','nsenter','-t','321','-m','--','sh','-c',shlex.quote('sha256sum '+M.STORE+'/*')))
        for text in ('',row+row,'not-a-hash '+M.STORE+'/1234abcd.0'):
            with patch.object(M,'shell',return_value=text), self.assertRaises(ValueError): M.inventory({})

    def test_pretrust_failure_occurs_before_root_or_push(self):
        state={'sourceHead':'a'*40};ready={}
        with tempfile.TemporaryDirectory(prefix='obsync-ca-gate-') as tmp:
            path=Path(tmp)/'proof.json';path.write_text('{}')
            with patch.object(M,'preflight',return_value=(state,ready)), patch.object(M,'cert_info',return_value={}), \
                 patch.object(M.SESSION,'adb_command') as adb:
                with self.assertRaisesRegex(ValueError,'untrusted WebView rejection'): M.install(Path(tmp),path,'a'*64,path)
                adb.assert_not_called()

    def test_install_preserves_roots_apk_enforcement_and_never_restarts_apps(self):
        with tempfile.TemporaryDirectory(prefix='obsync-ca-install-') as tmp:
            run=Path(tmp);(run/'evidence').mkdir()
            state={'sourceHead':'a'*40,'serial':'emulator-5584','reversePorts':[18473]}
            ready={'apkSha256':'b'*64}; ca={'sha256':'c'*64,'name':'1234abcd.0','notAfter':'synthetic'}
            original={'5678abcd.0':'d'*64}; expected=original|{ca['name']:ca['sha256']}
            target={'role':'md.obsidian','pid':321,'namespace':'mnt:[123]','startTicks':'77'}
            commands=[]
            def shell(state,*args,**kwargs):
                commands.append(args)
                if args==('id','-u'): return '0'
                if args==('getenforce',): return 'Enforcing'
                if args==('cat','/proc/sys/kernel/random/boot_id'):return 'boot-two'
                if args[0]=='cat':return '321 (synthetic) '+' '.join(['0']*19+['77'])
                return ''
            with patch.object(M,'preflight',return_value=(state,ready)), patch.object(M,'cert_info',return_value=ca), \
                 patch.object(M,'untrusted_receipt',return_value='e'*64), patch.object(M,'apk_hash',return_value=ready['apkSha256']), \
                 patch.object(M,'shell',side_effect=shell), patch.object(M,'namespaces',return_value=[target]), \
                 patch.object(M,'inventory',side_effect=[original,expected]), patch.object(M.SESSION,'adb_command') as adb, \
                 patch.object(M.SESSION,'register_emulator'), patch.object(M.SESSION,'check_reverse'):
                proof=M.install(run,run/'ca.crt','c'*64,run/'before.json')
            self.assertEqual(proof['result'],'INSTALLED');self.assertTrue(proof['originalRootsPreserved'])
            self.assertFalse(proof['appRestarted']);self.assertFalse(proof['zygoteRestarted'])
            self.assertEqual(proof['selinux'],'Enforcing');self.assertEqual(proof['apkSha256'],ready['apkSha256'])
            self.assertEqual(proof['webViewTrustedProbe'],'REQUIRED');self.assertEqual(proof['wrongHostnameProbe'],'REQUIRED')
            self.assertIn((state,['root']),[c.args for c in adb.call_args_list])
            self.assertTrue(any(args[:7]==('toybox','nsenter','-t','321','-m','--','mount') and '--bind' in args for args in commands))
            self.assertFalse(any(args[0] in ('setenforce','stop','start','reboot','am') for args in commands))
            commands.clear()
            def replay_shell(state,*args,**kwargs):
                if args[:2]==('sh','-c') and 'sha256sum' in args[2]:
                    return '\n'.join(value+' /guest/cacerts/'+name for name,value in expected.items())
                return shell(state,*args,**kwargs)
            with patch.object(M,'preflight',return_value=(state,ready)), patch.object(M,'cert_info',return_value=ca), \
                 patch.object(M,'untrusted_receipt',return_value='e'*64),patch.object(M,'apk_hash',return_value=ready['apkSha256']), \
                 patch.object(M,'shell',side_effect=replay_shell),patch.object(M,'namespaces',return_value=[target]) as namespaces, \
                 patch.object(M,'inventory',side_effect=[original,expected]),patch.object(M.SESSION,'adb_command') as replay_adb, \
                 patch.object(M.SESSION,'register_emulator'),patch.object(M.SESSION,'check_reverse'):
                replay=M.install(run,run/'ca.crt','c'*64,run/'before.json',reapply=True)
            self.assertTrue(replay['reapplied']);self.assertEqual(replay['bootId'],'boot-two')
            self.assertEqual(namespaces.call_args.kwargs,{'require_app':False})
            self.assertFalse(any(call.args[1][0]=='push' for call in replay_adb.call_args_list))
            self.assertEqual(len(list((run/'evidence').glob('android-trust-reapply-*.json'))),1)
            for args in commands:
                if args[:2]==('sh','-c'): self.assertEqual(len(shlex.split(args[2])),1)


if __name__=='__main__':unittest.main()
