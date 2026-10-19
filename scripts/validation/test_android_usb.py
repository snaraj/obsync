"""USB adapter contracts only; no native commands, USB enumeration or network."""
import hashlib
import contextlib
import io
import importlib.util
import json
from pathlib import Path
import tempfile
import time
import subprocess
import unittest
from unittest.mock import patch

SPEC=importlib.util.spec_from_file_location('android_usb',Path(__file__).with_name('android-usb.py'))
M=importlib.util.module_from_spec(SPEC);SPEC.loader.exec_module(M)


def guarded():
    argv=['/owned/sdk/platform-tools/adb','--one-device','SYNTHETIC123','-L','tcp:29345','server','nodaemon']
    return {'targetKind':'usb','serial':'SYNTHETIC123','sdk':'/owned/sdk','adbPort':29345,
        'usb':{'ownerApprovedDedicatedFixture':True,'serialSha256':hashlib.sha256(b'SYNTHETIC123').hexdigest()},
        'processes':{'adb':{'argv':argv,'identity':'synthetic '+ ' '.join(argv)}}}


class Guards(unittest.TestCase):
    def test_owner_key_wait_is_bounded_and_never_accepts_another_serial(self):
        state={'expiresAtEpoch':time.time()+60};denied=subprocess.CalledProcessError(1,['scoped-adb'],stderr=b'device unauthorized')
        with patch.object(M.COMMON,'adb_command',side_effect=[denied,'SYNTHETIC123']),patch.object(M.time,'sleep'),contextlib.redirect_stdout(io.StringIO()) as output:
            M.authorized_serial(state,'SYNTHETIC123')
        self.assertIn('OWNER_KEY_APPROVAL_REQUIRED',output.getvalue());self.assertNotIn('SYNTHETIC123',output.getvalue())
        with patch.object(M.COMMON,'adb_command',return_value='OTHER'):
            with self.assertRaises(ValueError):M.authorized_serial(state,'SYNTHETIC123')
        with patch.object(M.COMMON,'adb_command') as call:
            with self.assertRaises(TimeoutError):M.authorized_serial({'expiresAtEpoch':0},'SYNTHETIC123')
            call.assert_not_called()

    def test_only_exact_supplied_usb_serial_and_one_device_server(self):
        M.target_guard(guarded())
        for mutate in (lambda s:s.update(serial='OTHER'),lambda s:s.update(serial='emulator-5584'),lambda s:s['usb'].update(ownerApprovedDedicatedFixture=False),lambda s:s['processes'].update(emulator={}),lambda s:s['processes']['adb']['argv'].remove('--one-device')):
            value=guarded();mutate(value)
            with self.assertRaises(ValueError):M.target_guard(value)

    def test_route_failure_precedes_all_usb_access(self):
        with tempfile.TemporaryDirectory(prefix='obsync-usb-config-') as tmp:
            root=Path(tmp).resolve();(root/'sdk/platform-tools').mkdir(parents=True);adb=root/'sdk/platform-tools/adb';adb.write_bytes(b'official adb')
            c={'schema':1,'targetKind':'usb','ownerApprovedDedicatedFixture':True,'serial':'SYNTHETIC123',
               'vaultPath':'/storage/emulated/0/Documents/Obsync-USB-Test','source':str(root/'source'),'sourceHead':'a'*40,
               'sdk':str(root/'sdk'),'adbSha256':M.COMMON.digest(adb),'desktopRun':str(root/'desktop'),
               'apk':{'url':'https://github.com/obsidianmd/obsidian-releases/releases/download/v1/Obsidian-1.apk','sha256':'b'*64},'trustedRoute':{}}
            path=root/'config.json';M.COMMON.save(path,c)
            with patch.object(M.subprocess,'check_output',side_effect=['a'*40,b'',str(root/'source/.git')]),patch.object(M,'trusted_route',side_effect=ValueError('trusted route missing')),patch.object(M.COMMON.Owned,'launch') as launch:
                with self.assertRaisesRegex(ValueError,'trusted route'):M.configuration(path,root/'run')
                launch.assert_not_called()
            for change in ({'ownerApprovedDedicatedFixture':False},{'serial':'1.2.3.4:5555'},{'vaultPath':'/storage/emulated/0/Documents/Personal'}):
                M.COMMON.save(path,c|change)
                with patch.object(M.subprocess,'check_output') as git:
                    with self.assertRaises(ValueError):M.configuration(path,root/'run')
                    git.assert_not_called()

    def test_https_route_is_bound_to_owned_transport_and_exact_leaf(self):
        with tempfile.TemporaryDirectory(prefix='obsync-usb-route-') as tmp:
            run=Path(tmp).resolve();(run/'private').mkdir();cert=run/'private/tls.crt'
            cert.write_text('-----BEGIN CERTIFICATE-----\nQQ==\n-----END CERTIFICATE-----\n')
            source=run/'source';script=run/'harness/scripts/validation/mobile-tls.mjs';script.parent.mkdir(parents=True);script.write_text('owned transport')
            argv=['node',str(script),str(run),str(source/'scripts/ci/observer.mjs'),'12345','18473']
            binding={'schema':1,'bind':'127.0.0.1','upstreamPort':12345,'tlsPort':18473,'recorderPort':22345,'pid':42,'identity':'owned '+' '.join(argv),'argv':argv,'scriptSha256':M.COMMON.digest(script)}
            path=run/'private/tls-binding.json';M.COMMON.save(path,binding)
            state={'source_head':'a'*40,'server_port':12345,'processes':{'tls':binding}}
            c={'source':source,'sourceHead':'a'*40,'desktopRun':str(run),'trustedRoute':{'url':'https://owner-supplied.example:18473','bindingSha256':M.COMMON.digest(path),'leafDerSha256':hashlib.sha256(b'A').hexdigest(),'transport':'adb-reverse'}}
            class Connection:
                sock=type('Socket',(),{'getpeercert':lambda self,**kw:b'A'})()
                def connect(self):pass
                def request(self,*args):self.requested=args
                def getresponse(self):return type('Response',(),{'status':200,'read':lambda self,n:b'{"ready":true}'})()
                def close(self):pass
            with patch.object(M.PLATFORM,'desktop_binding',return_value=(state,{})),patch.object(M.COMMON,'identity',return_value=binding['identity']),patch.object(M.SESSION,'listener'),patch.object(M.ssl,'create_default_context',return_value=type('Context',(),{'verify_flags':0})()),patch.object(M.http.client,'HTTPSConnection',return_value=Connection()) as connection:
                self.assertTrue(M.trusted_route(c)['sameOwnedServerBinding']);self.assertEqual(connection.call_args.kwargs['timeout'],10)
                c['trustedRoute']['url']='https://owner-supplied.example:443'
                with self.assertRaises(ValueError):M.trusted_route(c)


class Cleanup(unittest.TestCase):
    def test_lost_reverse_still_stops_owned_groups_and_preserves_unknown_custody(self):
        with tempfile.TemporaryDirectory(prefix='obsync-usb-clean-') as tmp:
            run=Path(tmp).resolve()/'run';calls=[];stops=[]
            c={'serial':'SYNTHETIC123','sdk':Path('/owned/sdk'),'desktopRun':'/owned/desktop','sourceHead':'a'*40,'seconds':60,'vaultPath':'/storage/emulated/0/Documents/Obsync-USB-Test',
               'adbSha256':'b'*64,'apk':{'sha256':hashlib.sha256(b'official apk').hexdigest(),'url':'official'},
               'routeProof':{'transport':'adb-reverse','port':18473}}
            class Owner:
                def __init__(self,run,state):self.state=state;self.children={}
                def launch(self,name,argv,env):
                    child=type('Child',(),{'pid':44 if name=='adb' else 45,'name':name,'args':argv})()
                    self.children[name]=child;return child
                def record(self,name):self.state['processes'][name]={'pid':44,'identity':'owned '+' '.join(self.children[name].args)}
                def stop(self):stops.append(True)
            def adb(state,args,**kwargs):
                calls.append(args)
                if args==['get-serialno']:return 'SYNTHETIC123'
                if args[:3]==['shell','pm','path']:return 'package:/data/app/owned/base.apk'
                if args[:2]==['exec-out','cat']:return b'official apk'
                if args==['reverse','--list']:return ''
                if args[:2]==['reverse','--remove']:raise RuntimeError('USB disconnected')
                if args[:2]==['shell','getprop']:return 'bounded'
                return ''
            with patch.object(M.COMMON,'Owned',Owner),patch.object(M.COMMON,'free_port',return_value=29345),patch.object(M.COMMON,'identity',return_value='owned'),patch.object(M.COMMON,'adb_listener'),patch.object(M.COMMON,'app_pid',return_value=321),patch.object(M.COMMON,'adb_command',side_effect=adb),patch.object(M.COMMON,'exit_code',side_effect=lambda child:0 if child.name=='journey' else None):
                with contextlib.redirect_stdout(io.StringIO()),self.assertRaisesRegex(RuntimeError,'disconnected'):M.execute(c,run,['same-runner'])
            self.assertTrue(stops);self.assertTrue((run/'android.json').exists())
            result=json.loads((run/'evidence/result.json').read_text());self.assertEqual(result['cleanup'],'FAIL');self.assertEqual(result['result'],'FAIL')
            self.assertFalse(result['freshPhysicalEnvironment']);self.assertTrue(result['hostCleanupDoesNotAssertDeviceCleanup'])
            self.assertFalse(any(args[0] in ('root','reboot','install','uninstall','remount','devices') for args in calls))


if __name__=='__main__':unittest.main()
