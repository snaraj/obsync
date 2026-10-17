"""Behavioral negative controls; no SDK, emulator, USB or credentials needed."""
import ast
import copy
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import signal
import subprocess
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import zipfile

SPEC = importlib.util.spec_from_file_location('android_session', Path(__file__).with_name('android-session.py'))
M = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(M)


class Assets(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='obsync-android-test-')
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name).resolve()
        self.sdk, self.java = self.root/'sdk', self.root/'java'
        self.apk = self.root/'Obsidian-test.apk'; self.apk.write_bytes(b'official fixture')
        files = ['platform-tools/adb', 'emulator/emulator', 'cmdline-tools/latest/bin/avdmanager',
                 'system-images/android-35/google_apis/arm64-v8a/system.img',
                 'system-images/android-35/google_apis/arm64-v8a/kernel-ranchu']
        self.assets = {'apk': {'path': str(self.apk), 'sha256': M.digest(self.apk),
            'url': 'https://github.com/obsidianmd/obsidian-releases/releases/download/v1/Obsidian-1.apk'},
            'archives': []}
        for root, names, name, url in [(self.sdk, files, 'sdk.zip', 'https://dl.google.com/android/repository/sdk.zip'),
            (self.java, ['bin/java', 'lib/runtime'], 'java.zip', 'https://github.com/adoptium/temurin21-binaries/releases/download/test/java.zip')]:
            archive = self.root/name
            with zipfile.ZipFile(archive, 'w') as z:
                for rel in names:
                    p = root/rel; p.parent.mkdir(parents=True, exist_ok=True)
                    p.write_bytes(('fixture '+rel).encode()); z.writestr(rel, p.read_bytes())
            self.assets['archives'].append({'path': str(archive), 'sha256': M.digest(archive),
                'url': url, 'installRoot': str(root)})
        self.manifest = self.root/'assets.json'

    def verify(self):
        self.manifest.write_text(json.dumps(self.assets))
        return M.verify_assets(self.manifest, self.sdk, self.java, 'system-images;android-35;google_apis;arm64-v8a')

    def test_official_pins_and_installed_bytes(self):
        apk, proof = self.verify()
        self.assertEqual(apk, self.apk)
        self.assertEqual(sum(p['verifiedFiles'] for p in proof['archives']), 7)

    def test_apk_wrong_hash_and_unofficial_origin_refuse(self):
        self.apk.write_bytes(b'replaced')
        with self.assertRaisesRegex(ValueError, 'SHA-256 mismatch'): self.verify()
        self.assets['apk']['sha256'] = M.digest(self.apk)
        self.assets['apk']['url'] = 'https://example.invalid/Obsidian.apk'
        with self.assertRaisesRegex(ValueError, 'official Obsidian'): self.verify()

    def test_modified_installed_tool_image_or_java_refuse(self):
        for p in (self.sdk/'platform-tools/adb', self.sdk/'system-images/android-35/google_apis/arm64-v8a/system.img', self.java/'bin/java'):
            original = p.read_bytes(); p.write_bytes(b'tampered')
            with self.subTest(path=p.name), self.assertRaisesRegex(ValueError, 'differs from official'):
                self.verify()
            p.write_bytes(original)

    def test_extra_runtime_library_refuses(self):
        (self.java/'lib/unverified').write_bytes(b'library')
        with self.assertRaisesRegex(ValueError, 'unverified installed tooling'): self.verify()

    def test_missing_required_tool_and_empty_archive_refuse(self):
        (self.sdk/'platform-tools/adb').unlink()
        with self.assertRaisesRegex(ValueError, 'regular artifact'): self.verify()
        self.assets['archives'] = []
        with self.assertRaisesRegex(ValueError, 'absent from verified'): self.verify()

    def test_apk_link_and_archive_digest_refuse(self):
        other = self.root/'other'; self.apk.rename(other); self.apk.symlink_to(other)
        with self.assertRaisesRegex(ValueError, 'regular artifact'): self.verify()
        self.apk.unlink(); other.rename(self.apk)
        self.assets['archives'][0]['sha256'] = '0'*64
        with self.assertRaisesRegex(ValueError, 'SHA-256 mismatch'): self.verify()

    def test_archive_traversal_refuses_without_writing(self):
        item = self.assets['archives'][0]
        with zipfile.ZipFile(item['path'], 'a') as z: z.writestr('../escape', b'sentinel')
        item['sha256'] = M.digest(item['path'])
        with self.assertRaisesRegex(ValueError, 'unsafe archive'): self.verify()
        self.assertFalse((self.root/'escape').exists())

    def test_validate_preserves_existing_and_refuses_wrong_source(self):
        a = SimpleNamespace(seconds=14400, boot_seconds=240, port=5584, source=self.root/'source',
            source_head='a'*40, run=self.root/'run', sdk=self.sdk, java=self.java, assets=self.manifest,
            system_image='system-images;android-35;google_apis;arm64-v8a', reverse=[])
        a.run.mkdir(); (a.run/'sentinel').write_text('keep')
        with self.assertRaisesRegex(ValueError, 'fresh run'): M.validate(a)
        self.assertEqual((a.run/'sentinel').read_text(), 'keep')
        a.run = self.root/'new'
        for key, value in [('seconds', 0), ('seconds', 86401), ('port', 5555), ('boot_seconds', 0)]:
            b = copy.copy(a); setattr(b, key, value)
            with self.subTest(key=key, value=value), self.assertRaisesRegex(ValueError, {'seconds':'duration', 'port':'console port', 'boot_seconds':'boot budget'}[key]): M.validate(b)
        a.run = self.root/'new'
        def git(args, **_):
            if args[-1] == '--git-common-dir': return str(self.root/'source/.git')+'\n'
            if args[-1] == 'HEAD': return 'b'*40+'\n'
            return b''
        with patch.object(M.subprocess, 'check_output', side_effect=git):
            with self.assertRaisesRegex(ValueError, 'exact candidate'): M.validate(a)
        self.assertFalse(a.run.exists())


class Control(unittest.TestCase):
    def test_actual_emulator_launch_is_headless_and_preserves_explicit_options(self):
        tree=ast.parse(Path(M.__file__).read_text())
        execute=next(n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name=='execute')
        launch=next(n for n in ast.walk(execute) if isinstance(n,ast.Assign) and any(isinstance(t,ast.Name) and t.id=='emulator' for t in n.targets))
        route=['-feature','-WiFiPacketStream','-network-user-mode-options','restrict=on','-wifi-user-mode-options','restrict=on,dhcpstart=10.0.2.16,hostfwd=tcp:127.0.0.1:12346-10.0.2.16:5555','-debug','init']
        env={'HOME':'/owned/private'};calls=[]
        scope={'a':SimpleNamespace(sdk=Path('/owned/sdk'),port=5584,gpu='software'),'route_argv':route,'env':env,'owned':SimpleNamespace(launch=lambda *args:calls.append(args))}
        exec(compile(ast.fix_missing_locations(ast.Module(body=[launch],type_ignores=[])),'actual-owned-emulator-launch','exec'),scope)
        self.assertEqual(len(calls),1);self.assertEqual(calls[0][0],'emulator');self.assertIs(calls[0][2],env)
        self.assertEqual(calls[0][1],['/owned/sdk/emulator/emulator','-avd','obsync-acceptance','-port','5584',*route,'-no-window','-no-audio','-no-boot-anim','-no-snapshot-load','-no-snapshot-save','-no-metrics','-crash-report-mode','never','-cores','2','-memory','2048','-gpu','software'])

    def test_env_removes_host_android_settings(self):
        with patch.dict(os.environ, {'ADBHOST':'personal', 'ADB_VENDOR_KEYS':'personal', 'ANDROID_USER_HOME':'personal'}):
            env = M.adb_env({'environment': {'ADB_USB':'0', 'ADB_VENDOR_KEYS':'owned'}})
        self.assertEqual(env['ADB_USB'], '0'); self.assertEqual(env['ADB_VENDOR_KEYS'], 'owned')
        self.assertNotIn('ANDROID_USER_HOME', env); self.assertNotIn('ADBHOST', env)

    def test_device_commands_pin_server_and_serial(self):
        state = {'sdk':'/synthetic/sdk', 'serial':'emulator-5584', 'adbPort':12345, 'expiresAtEpoch':10**12, 'environment':{'ADB_USB':'0'}}
        with patch.object(M.subprocess, 'check_output', return_value='1') as call:
            self.assertEqual(M.adb_command(state, ['shell','getprop','sys.boot_completed']), '1')
        self.assertEqual(call.call_args.args[0], ['/synthetic/sdk/platform-tools/adb','-P','12345','-s','emulator-5584','shell','getprop','sys.boot_completed'])
        self.assertEqual(call.call_args.kwargs['env']['ADB_USB'], '0')

    def test_emulator_registration_is_private_and_does_not_expect_reply(self):
        class NotificationSocket:
            def __enter__(self): return self
            def __exit__(self, *args): pass
            def sendall(self, data): self.data=data
        conn=NotificationSocket()
        with patch.object(M.socket, 'create_connection', return_value=conn) as call:
            M.register_emulator({'adbPort':12345},5585)
        self.assertEqual(call.call_args.args[0], ('127.0.0.1',12345))
        self.assertEqual(conn.data, b'0012host:emulator:5585')

    def test_expired_adb_command_does_not_start_a_client(self):
        state={'sdk':'/synthetic/sdk', 'serial':'emulator-5584', 'adbPort':12345,
               'environment':{}, 'expiresAtEpoch':0}
        with patch.object(M.subprocess, 'check_output') as call:
            with self.assertRaisesRegex(TimeoutError, 'deadline'): M.adb_command(state,['shell','true'])
            call.assert_not_called()

    def test_lost_reverse_is_failure_not_repaired_or_ignored(self):
        state = {'reversePorts':[18443]}
        with patch.object(M, 'adb_command', return_value=''):
            with self.assertRaisesRegex(RuntimeError, 'reverse missing'): M.check_reverse(state)
        with patch.object(M, 'adb_command', return_value='emulator-5584 tcp:18443 tcp:18443\n'):
            M.check_reverse(state)

    def test_stale_or_changed_owner_cannot_send_command(self):
        with tempfile.TemporaryDirectory(prefix='obsync-owner-test-') as tmp:
            run = Path(tmp).resolve()
            state = {'format':1, 'run':str(run), 'expiresAtEpoch':0}
            (run/'android.json').write_text(json.dumps(state))
            with self.assertRaisesRegex(ValueError, 'expired'): M.live_state(run)
            state.update(expiresAtEpoch=10**12, holder={'pid':321, 'identity':'owned'}, processes={})
            (run/'android.json').write_text(json.dumps(state))
            with patch.object(M, 'identity', return_value='changed'):
                with self.assertRaisesRegex(RuntimeError, 'identity changed'): M.live_state(run)

    def test_exited_process_error_identifies_each_name_and_exit_code(self):
        owned=M.Owned(Path('/synthetic/run'),{})
        owned.children={'adb':SimpleNamespace(poll=lambda:17), 'emulator':SimpleNamespace(poll=lambda:-9)}
        with patch.object(M,'exit_code',side_effect=[-9,17]):
            with self.assertRaisesRegex(RuntimeError, 'boot: emulator exit=-9, adb exit=17'):
                owned.require_running('boot')

    def test_listener_proof_scopes_pid_port_and_refuses_wildcard(self):
        with tempfile.TemporaryDirectory(prefix='obsync-listener-test-') as tmp:
            run=Path(tmp); (run/'evidence').mkdir()
            owned=M.Owned(run,{}); owned.children={'adb':SimpleNamespace(pid=321)}
            state={'adbPort':12345,'expiresAtEpoch':10**12}
            with patch.object(M,'exit_code',return_value=None), patch.object(M.subprocess,'run',
                    return_value=SimpleNamespace(returncode=0,stdout='p321\nn127.0.0.1:12345\n')) as call:
                M.adb_listener(owned,state)
                self.assertEqual(call.call_args.args[0],['lsof','-nP','-a','-p','321','-iTCP:12345','-sTCP:LISTEN','-Fn'])
            self.assertEqual(json.loads((run/'evidence/adb-listener.json').read_text())['address'],'127.0.0.1')
            with patch.object(M,'exit_code',return_value=None), patch.object(M.subprocess,'run',
                    return_value=SimpleNamespace(returncode=0,stdout='p321\nn*:12345\n')):
                with self.assertRaisesRegex(RuntimeError,'not exclusively IPv4 loopback'): M.adb_listener(owned,state)

    def test_exited_leader_keeps_pid_reserved_until_group_cleanup(self):
        with tempfile.TemporaryDirectory(prefix='obsync-orphan-test-') as tmp:
            run=Path(tmp); (run/'private').mkdir()
            owned=M.Owned(run,{})
            child=owned.launch('sentinel',[sys.executable,'-c',
                'import os,time; pid=os.fork(); time.sleep(60) if pid==0 else None'],dict(os.environ))
            try:
                deadline=M.time.monotonic()+3
                while M.exit_code(child) is None:
                    if M.time.monotonic()>deadline: self.fail('synthetic leader did not exit')
                    M.time.sleep(.02)
                self.assertIsNone(child.returncode)  # WNOWAIT did not reap the anchor
                self.assertTrue(any(not status.startswith('Z') for _,status in M.group_members(child.pid)))
                owned.stop()
                self.assertIsNotNone(child.returncode)
                self.assertEqual(M.group_members(child.pid),[])
            finally:
                if child.returncode is None: owned.stop()

    def test_owned_child_cleanup_on_failure_and_no_unrelated_signal(self):
        with tempfile.TemporaryDirectory(prefix='obsync-cleanup-test-') as tmp:
            run=Path(tmp); (run/'private').mkdir()
            owned=M.Owned(run, {'processes':{}})
            child=owned.launch('sentinel', [sys.executable, '-c', 'import time; time.sleep(60)'], dict(os.environ))
            try:
                owned.stop()
                self.assertIsNotNone(child.returncode)
                with self.assertRaises(ProcessLookupError): os.killpg(child.pid, 0)
            finally:
                if child.poll() is None: child.kill(); child.wait()


class LifecycleAPIs(unittest.TestCase):
    def test_force_stop_proves_old_pid_and_devtools_absence_without_clear_data(self):
        with patch.object(M,'app_pid',side_effect=[111,None,None]), \
             patch.object(M,'devtools_present',side_effect=[True,False]), \
             patch.object(M,'adb_command') as adb, patch.object(M.time,'sleep'):
            self.assertEqual(M.stopped_app({}),111)
            self.assertEqual(adb.call_args.args,({},['shell','am','force-stop','md.obsidian']))

    def test_restart_refuses_old_boot_trust_before_starting_application(self):
        with tempfile.TemporaryDirectory(prefix='obsync-boot-trust-') as tmp:
            run=Path(tmp);(run/'evidence').mkdir()
            (run/'evidence/android-trust.json').write_text('{}')
            (run/'evidence/android-trust-current.json').write_text(json.dumps({'bootId':'old'}))
            with patch.object(M,'live_state',return_value={}), patch.object(M,'check_reverse'), \
                 patch.object(M,'adb_command',return_value='new'),patch.object(M,'stopped_app') as stop:
                with self.assertRaisesRegex(RuntimeError,'reapply owned synthetic CA'):M.lifecycle(run,'restart-app')
                stop.assert_not_called()

    def test_restart_uses_resolved_activity_and_fresh_process_socket(self):
        with tempfile.TemporaryDirectory(prefix='obsync-restart-api-') as tmp:
            run=Path(tmp);(run/'evidence').mkdir();calls=[]
            def adb(state,args,**kwargs):
                calls.append(args)
                if 'resolve-activity' in args:return 'md.obsidian/.MainActivity'
                return 'same-boot'
            with patch.object(M,'live_state',return_value={'sourceHead':'a'*40}),patch.object(M,'check_reverse'), \
                 patch.object(M,'adb_command',side_effect=adb),patch.object(M,'stopped_app',return_value=111), \
                 patch.object(M,'app_pid',return_value=222),patch.object(M,'devtools_present',return_value=True):
                proof=M.lifecycle(run,'restart-app')
            self.assertEqual(proof['result'],'RESTARTED');self.assertEqual(proof['newPid'],222)
            self.assertTrue(proof['oldProcessAndSocketAbsent']);self.assertFalse(proof['appDataReset'])
            self.assertIn(['shell','am','start','-W','-n','md.obsidian/.MainActivity'],calls)

    def test_guest_reboot_requires_new_boot_and_restores_only_owned_reverse(self):
        with tempfile.TemporaryDirectory(prefix='obsync-reboot-api-') as tmp:
            run=Path(tmp);(run/'evidence').mkdir();(run/'evidence/android-trust.json').write_text('{}')
            state={'sourceHead':'a'*40,'serial':'emulator-5584','reversePorts':[18473],'expiresAtEpoch':10**12}
            boots=iter(['old','old','new']);calls=[]
            def adb(state,args,**kwargs):
                calls.append(args)
                if args==['shell','cat','/proc/sys/kernel/random/boot_id']:return next(boots)
                if args==['shell','getprop','sys.boot_completed']:return '1'
                return ''
            with patch.object(M,'live_state',return_value=state),patch.object(M,'check_reverse') as reverse, \
                 patch.object(M,'adb_command',side_effect=adb),patch.object(M,'stopped_app',return_value=111), \
                 patch.object(M,'app_pid',return_value=None),patch.object(M,'register_emulator'),patch.object(M.time,'sleep'):
                proof=M.lifecycle(run,'reboot')
            self.assertEqual(proof['newBootId'],'new');self.assertTrue(proof['actualGuestReboot'])
            self.assertTrue(proof['trustReapplyRequired']);self.assertTrue(proof['applicationStopped'])
            self.assertFalse(proof['reverseMappingsSurvived']);self.assertEqual(reverse.call_count,2)
            self.assertIn(['reverse','tcp:18473','tcp:18473'],calls);self.assertIn(['reboot'],calls)


class HomeObservation(unittest.TestCase):
    FOREGROUND='mResumedActivity: ActivityRecord{abc u0 md.obsidian/.MainActivity t5}'
    BACKGROUND='topResumedActivity=ActivityRecord{def u0 com.android.launcher/.Launcher t2}'
    NULL='mResumedActivity: null'

    def observe(self, activities, pids=None, expires=1030, fail_command=None, late_final_pid=False):
        self.clock=0.;self.calls=[];self.timeouts=[];self.pid_reads=0;self.activity_reads=0
        values=iter(pids) if pids else None
        def adb(state,args,timeout=30,**kwargs):
            self.calls.append(args);self.timeouts.append(timeout)
            if fail_command and args==fail_command[0]:raise fail_command[1]
            if args==['shell','pidof','md.obsidian']:
                self.pid_reads+=1;value=next(values,'111') if values else '111'
                if late_final_pid and self.pid_reads==3:self.clock+=31
                if value is None:raise subprocess.CalledProcessError(1,['owned-adb'])
                return value
            if args==['shell','dumpsys','activity','activities']:
                index=min(self.activity_reads,len(activities)-1);self.activity_reads+=1;return activities[index]
            if args==['shell','input','keyevent','KEYCODE_HOME']:return ''
            raise AssertionError('unexpected device command')
        def sleep(seconds):self.clock+=seconds
        with patch.object(M,'adb_command',side_effect=adb),patch.object(M.time,'time',return_value=1000):
            return M.background_after_one_home({'expiresAtEpoch':expires},clock=lambda:self.clock,sleep=sleep)

    def homes(self):return self.calls.count(['shell','input','keyevent','KEYCODE_HOME'])

    def test_single_home_waits_passively_for_positive_background_and_same_pid(self):
        proof=self.observe([self.FOREGROUND,self.NULL,self.BACKGROUND])
        self.assertEqual(proof['result'],'BACKGROUNDED');self.assertEqual(proof['polls'],3)
        self.assertEqual(self.homes(),1);self.assertEqual(proof['homeKeypressCount'],1)
        self.assertEqual(proof['applicationPid'],111);self.assertTrue(proof['processRetained'])
        self.assertEqual(proof['before']['obsidianResumedCount'],1);self.assertEqual(proof['after']['otherResumedCount'],1)
        self.assertEqual(proof['elapsedMs'],200);self.assertTrue(all(0<value<=30 for value in self.timeouts))
        self.assertNotIn('launcher',json.dumps(proof));self.assertNotIn('ActivityRecord',json.dumps(proof))

    def test_absent_null_foreground_or_mixed_resumed_activity_never_proves_background(self):
        for text in ['',self.NULL,'mResumedActivity: malformed',self.FOREGROUND,self.FOREGROUND+'\n'+self.BACKGROUND]:
            with self.subTest(text=text),self.assertRaises(M.HomeObservationError) as result:self.observe([text])
            self.assertEqual(result.exception.reason,'home_background_deadline');self.assertEqual(self.homes(),1)
            self.assertEqual(result.exception.diagnostic['elapsedMs'],30000);self.assertGreater(result.exception.diagnostic['polls'],1)
        self.assertEqual(M.resumed_activity_counts(self.NULL)['resumedActivityCount'],0)

    def test_missing_or_changed_process_is_immediate_failure_without_retry(self):
        for pids in [['111','222','111'],['111','111',None,'111']]:
            with self.subTest(pids=pids),self.assertRaises(M.HomeObservationError) as result:self.observe([self.BACKGROUND],pids)
            self.assertEqual(result.exception.reason,'home_application_process_changed');self.assertEqual(self.homes(),1)
            self.assertFalse(result.exception.diagnostic['processRetained']);self.assertLessEqual(self.pid_reads,3)
        with self.assertRaises(M.HomeObservationError) as result:self.observe([self.BACKGROUND],[None])
        self.assertEqual(result.exception.reason,'home_application_absent');self.assertEqual(self.homes(),0)
        for invalid in ['0','111 222','invalid']:
            with self.assertRaises(M.HomeObservationError) as result:self.observe([self.BACKGROUND],[invalid])
            self.assertEqual(result.exception.reason,'home_invalid_application_pid');self.assertEqual(self.homes(),0)

    def test_session_expiry_and_late_success_cannot_extend_fixed_budget(self):
        with self.assertRaises(M.HomeObservationError) as result:self.observe([self.NULL],expires=1000.25)
        self.assertEqual(result.exception.diagnostic['elapsedMs'],250);self.assertEqual(self.homes(),1)
        self.assertTrue(all(value<=.25 for value in self.timeouts))
        with self.assertRaises(M.HomeObservationError) as result:self.observe([self.BACKGROUND],late_final_pid=True)
        self.assertEqual(result.exception.reason,'home_background_deadline');self.assertEqual(self.homes(),1)

    def test_command_errors_never_promote_private_stderr(self):
        command=['shell','dumpsys','activity','activities']
        for error,reason in [(subprocess.TimeoutExpired(['private-command'],1,stderr=b'private-value'),'home_device_command_timeout'),
                             (subprocess.CalledProcessError(7,['private-command'],stderr=b'private-value'),'home_device_command_failed')]:
            with self.assertRaises(M.HomeObservationError) as result:self.observe([self.BACKGROUND],fail_command=(command,error))
            self.assertEqual(result.exception.reason,reason);self.assertNotIn('private',str(result.exception))
            self.assertNotIn('private',json.dumps(result.exception.diagnostic));self.assertEqual(self.homes(),1)

    def test_lifecycle_retains_constant_failure_receipt_with_counts(self):
        with tempfile.TemporaryDirectory(prefix='obsync-home-proof-') as tmp:
            run=Path(tmp);(run/'evidence').mkdir()
            error=M.HomeObservationError('home_background_deadline',{'stage':'observe_home_background','homeKeypressCount':1,'polls':4,'before':{'resumedActivityCount':1},'after':{'resumedActivityCount':0}})
            with patch.object(M,'live_state',return_value={'sourceHead':'a'*40}),patch.object(M,'check_reverse'),patch.object(M,'background_after_one_home',side_effect=error):
                with self.assertRaises(M.HomeObservationError):M.lifecycle(run,'home')
            files=list((run/'evidence').glob('android-home-failure-*.json'));self.assertEqual(len(files),1)
            receipt=json.loads(files[0].read_text());self.assertEqual(receipt['result'],'FAIL');self.assertEqual(receipt['polls'],4)
            self.assertEqual(receipt['reason'],'home_background_deadline');self.assertEqual(receipt['after']['resumedActivityCount'],0)


class InitialApkGate(unittest.TestCase):
    def test_actual_initial_install_block_requires_one_complete_shared_verification(self):
        import textwrap
        source=Path(M.__file__).read_text()
        first=source.index("        stage = 'install'");last=source.index("        activity = adb_command",first)
        block=compile(textwrap.dedent(source[first:last]),'actual-initial-apk-gate','exec')
        official=b'official apk controller fixture';remote='/data/app/~~synthetic==/md.obsidian-owned==/base.apk'
        for mode in ('correct','changed','failed-pull'):
            with self.subTest(mode=mode),tempfile.TemporaryDirectory(prefix='obsync-initial-apk-gate-') as tmp:
                run=Path(tmp).resolve();(run/'private').mkdir(mode=0o700);(run/'evidence').mkdir();calls=[]
                content=b'other installed bytes' if mode=='changed' else official
                def adb(state,args,timeout=30,**kwargs):
                    calls.append(args)
                    if args[0]=='install':return 'Success'
                    if args[:3]==['shell','pm','path']:return 'package:'+remote
                    if args[:5]==['shell','toybox','stat','-c','%s']:return str(len(content))
                    if args[:3]==['shell','toybox','sha256sum']:return hashlib.sha256(content).hexdigest()+'  '+remote
                    if args[:2]==['pull',remote]:
                        Path(args[2]).write_bytes(content)
                        if mode=='failed-pull':raise subprocess.CalledProcessError(9,['synthetic-pull'])
                        return 'complete'
                    raise AssertionError('no raw exec, app launch or other operation is allowed')
                namespace={'APK':M.APK,'state':{'sourceHead':'a'*40,'expiresAtEpoch':10**12},'a':SimpleNamespace(run=run),
                           'apk':run/'official.apk','proof':{'apkSha256':hashlib.sha256(official).hexdigest()},'adb_command':adb,'save':M.save}
                if mode=='correct':exec(block,namespace)
                else:
                    reason='apk_official_pin_mismatch' if mode=='changed' else 'apk_device_command_failed'
                    with self.assertRaisesRegex(M.APK.ApkReadbackError,reason):exec(block,namespace)
                self.assertEqual(sum(call[:1]==['pull'] for call in calls),1)
                proof=json.loads(next((run/'evidence').glob('android-apk-readback-*.json')).read_text())
                self.assertEqual(proof['phase'],'initial-install');self.assertTrue(proof['temporaryRemoved'])
                self.assertEqual(proof['result'],'VERIFIED' if mode=='correct' else 'FAIL')
                self.assertEqual(list((run/'private').iterdir()),[])


class Diagnostics(unittest.TestCase):
    def test_startup_diagnostics_are_bounded_redacted_and_phase_scoped(self):
        with tempfile.TemporaryDirectory(prefix='obsync-diagnostic-test-') as tmp:
            run=Path(tmp); (run/'private').mkdir(); (run/'evidence').mkdir()
            raw=('discarded-prefix'*1000+'\n'+'benign repeated error details\n'*300+'Error: renderer failed\n'
                 'token = do-not-retain\nprivate key: do-not-retain-key\n'
                 '/private/synthetic/person/runtime shader missing\n'
                 'https://synthetic.invalid/private 192.0.2.25 '+ 'ab'*32+'\n')
            for name in ('prepare','adb','emulator','journey'):
                (run/'private'/(name+'.log')).write_text(raw)
            error=subprocess.CalledProcessError(4,['synthetic-tool'],stderr=b'INSTALL_FAILED_TEST\nAuthorization: do-not-retain-auth')
            for stage in ('prepare','boot','install'):
                self.assertTrue(M.startup_diagnostics(run,stage,error))
                path=run/'evidence/startup-diagnostics.json'
                receipt=json.loads(path.read_text()); encoded=path.read_text()
                self.assertEqual(receipt['stage'],stage); self.assertEqual(receipt['returncode'],4)
                self.assertEqual(set(receipt['logs']),{'prepare','adb','emulator'})
                self.assertIn('renderer failed',encoded); self.assertIn('INSTALL_FAILED_TEST',encoded)
                for marker in ('[url]','[path]','[address]','[identifier]','[credential-related line omitted]'): self.assertIn(marker,encoded)
                for sentinel in ('do-not-retain','/private/synthetic','synthetic.invalid','192.0.2.25','ab'*32):
                    self.assertNotIn(sentinel,encoded)
                self.assertTrue(all(len(value)<=4096 for value in receipt['logs'].values()))
                path.unlink()
            self.assertFalse(M.startup_diagnostics(run,'journey',error))
            self.assertFalse((run/'evidence/startup-diagnostics.json').exists())

    def test_truncated_stderr_line_is_omitted_before_redaction(self):
        with tempfile.TemporaryDirectory(prefix='obsync-diagnostic-test-') as tmp:
            run=Path(tmp); (run/'private').mkdir(); (run/'evidence').mkdir()
            error=subprocess.CalledProcessError(4,['synthetic-tool'],stderr=b'token='+b'x'*9000+b' leaked fragment\nError: install failed')
            M.startup_diagnostics(run,'install',error)
            text=(run/'evidence/startup-diagnostics.json').read_text()
            self.assertNotIn('leaked fragment',text); self.assertIn('install failed',text)


class Lifecycle(unittest.TestCase):
    def exercise(self, journey_code, installed=b'fixture-apk', install='Success', timeout=False, prepare_failure=False,pull_failure=False):
        with tempfile.TemporaryDirectory(prefix='obsync-lifecycle-test-') as tmp:
            root = Path(tmp).resolve(); sdk=root/'sdk'; run=root/'new-run'
            apk=root/'fixture.apk'; apk.write_bytes(b'fixture-apk')
            for name, body in [('cmdline-tools/latest/bin/avdmanager', 'pass'),
                               ('platform-tools/adb', 'import time; time.sleep(60)'),
                               ('emulator/emulator', 'import time; time.sleep(60)')]:
                p=sdk/name; p.parent.mkdir(parents=True, exist_ok=True)
                p.write_text('#!'+sys.executable+'\n'+('raise SystemExit(4)' if prepare_failure and name.endswith('avdmanager') else body)+'\n'); p.chmod(0o700)
            a=SimpleNamespace(run=run, sdk=sdk, java=root/'java', source_head='a'*40,
                seconds=1 if timeout else 20, boot_seconds=2, reverse=[], port=5584,
                system_image='synthetic-image', device='synthetic-device', online=False,
                gpu='software', command=[sys.executable, '-c', journey_code])
            proof={'apkSha256':hashlib.sha256(b'fixture-apk').hexdigest()}
            calls=[]
            def device(state, args, **kwargs):
                calls.append(args)
                self.assertEqual(state['environment']['ADB_USB'], '0')
                self.assertEqual(state['environment']['ADB_EMU'], '0')
                self.assertEqual(state['environment']['ADB_MDNS'], '0')
                if args[:3] == ['shell','getprop','sys.boot_completed']: return '1'
                if args[:1] == ['install']: return install
                if args[:3] == ['shell','pm','path']: return 'package:/data/app/~~synthetic==/md.obsidian-owned==/base.apk'
                if args[:5] == ['shell','toybox','stat','-c','%s']:return str(len(installed))
                if args[:3] == ['shell','toybox','sha256sum']:return hashlib.sha256(installed).hexdigest()+'  /data/app/~~synthetic==/md.obsidian-owned==/base.apk'
                if args[:1] == ['pull']:
                    Path(args[2]).write_bytes(installed)
                    if pull_failure:raise subprocess.CalledProcessError(7,['private adb args'],stderr=b'private transfer details')
                    return 'pull completed'
                if args[:2] == ['exec-out','cat']:raise AssertionError('initial APK must not use the raw exec stream')
                if args[:3] == ['shell','cmd','package']: return 'md.obsidian/.MainActivity'
                return ''
            with patch.object(M, 'validate', return_value=(apk,proof)), \
                 patch.object(M, 'register_emulator'), patch.object(M, 'adb_listener'), \
                 patch.object(M, 'free_port', return_value=12345), \
                 patch.object(M, 'identity', side_effect=lambda pid: 'synthetic-owned-'+str(pid)), \
                 patch.object(M, 'adb_command', side_effect=device):
                try: M.execute(a)
                except Exception as error: failure=str(error)
                else: failure=None
            self.last_apk_proofs=[json.loads(path.read_text()) for path in (run/'evidence').glob('android-apk-readback-*.json')]
            receipt=json.loads((run/'evidence/result.json').read_text())
            diagnostic=run/'evidence/startup-diagnostics.json'
            self.assertEqual(diagnostic.exists(), bool(receipt['failure'] and receipt['failure']['stage'] in ('prepare','boot','install')))
            self.assertFalse((run/'runtime').exists()); self.assertFalse((run/'private').exists())
            self.assertFalse((run/'android.json').exists()); self.assertEqual(receipt['cleanup'], 'PASS')
            return receipt, failure, calls

    def test_success_requires_completed_journey_and_cleanup(self):
        receipt, failure, calls=self.exercise('pass')
        self.assertIsNone(failure); self.assertEqual(receipt['result'], 'PASS')
        self.assertEqual(receipt['ownedGroupsRemaining'], 0)
        self.assertTrue(receipt['runtimeAbsent'] and receipt['privateAbsent'] and receipt['manifestAbsent'])
        self.assertIn(['shell','svc','wifi','disable'], calls)
        self.assertEqual(sum(call[:1]==['pull'] for call in calls),1)
        self.assertEqual(self.last_apk_proofs[0]['result'],'VERIFIED')
        self.assertTrue(self.last_apk_proofs[0]['temporaryRemoved'])

    def test_prepare_failure_also_cleans_profile(self):
        receipt, failure, _=self.exercise('pass', prepare_failure=True)
        self.assertIsNotNone(failure); self.assertEqual(receipt['result'], 'FAIL')
        self.assertEqual(receipt['failure']['stage'], 'prepare')

    def test_sigterm_cleans_owned_processes_and_profile(self):
        receipt, failure, _=self.exercise('import os,signal; os.kill(os.getppid(),signal.SIGTERM)')
        self.assertIn('interrupted by signal', failure); self.assertEqual(receipt['result'], 'FAIL')

    def test_nonzero_journey_cannot_become_pass(self):
        receipt, failure, _=self.exercise('raise SystemExit(7)')
        self.assertIn('journey exited 7', failure); self.assertEqual(receipt['result'], 'FAIL')
        self.assertEqual(receipt['failure']['stage'], 'journey')

    def test_success_install_text_cannot_hide_changed_installed_apk(self):
        receipt, failure, _=self.exercise('pass', installed=b'changed')
        self.assertIn('apk_official_pin_mismatch', failure); self.assertEqual(receipt['result'], 'FAIL')

    def test_failed_complete_pull_cannot_launch_app_or_retry_even_when_local_bytes_match(self):
        receipt,failure,calls=self.exercise('pass',pull_failure=True)
        self.assertEqual(receipt['result'],'FAIL');self.assertEqual(receipt['cleanup'],'PASS')
        self.assertIn('apk_device_command_failed',failure);self.assertEqual(sum(call[:1]==['pull'] for call in calls),1)
        self.assertFalse(any(call[:3]==['shell','am','start'] for call in calls))
        proof=self.last_apk_proofs[0];self.assertEqual(proof['pullExitCode'],7);self.assertTrue(proof['temporaryRemoved'])
        self.assertEqual(proof['local']['sha256'],proof['expectedSha256']);self.assertEqual(proof['result'],'FAIL')
        self.assertNotIn('private transfer',json.dumps(proof))

    def test_install_exit_zero_with_failure_text_cannot_pass(self):
        receipt, failure, _=self.exercise('pass', install='Failure [INSTALL_FAILED]')
        self.assertIn('did not report Success', failure); self.assertEqual(receipt['result'], 'FAIL')

    def test_deadline_kills_owned_journey_and_cleans_profile(self):
        receipt, failure, _=self.exercise('import time; time.sleep(3)', timeout=True)
        self.assertIn('lifecycle deadline', failure); self.assertEqual(receipt['result'], 'FAIL')


import sys
if __name__ == '__main__': unittest.main()
