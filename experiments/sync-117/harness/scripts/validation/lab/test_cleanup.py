"""Cleanup must prove absence and preserve uncertain ownership; no personal fixtures."""
import contextlib
import io
import json
import os
from pathlib import Path
import signal
import runpy
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch, Mock
import lab
import finalize
import performance
import fixture

class Cleanup(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='obsync-cleanup-test-')
        self.addCleanup(self.tmp.cleanup)
        self.run = Path(self.tmp.name).resolve()
        (self.run/'evidence').mkdir()
        (self.run/'private').mkdir()
        (self.run/'private/secret').write_text('synthetic test secret')
        self.state = {'format':1,'run':str(self.run),'stopped':True,'devices':{},'processes':{}}
        self.receipt = {'process_groups_remaining':0,'runtime_exists':False}
        self.write()
    def write(self):
        (self.run/'lab.json').write_text(json.dumps(self.state))
        (self.run/'evidence/teardown.json').write_text(json.dumps(self.receipt))
    def finish(self):
        with contextlib.redirect_stdout(io.StringIO()): finalize.finalize(self.run)
    def assert_preserved(self):
        self.assertTrue((self.run/'private/secret').exists())
        self.assertTrue((self.run/'lab.json').exists())
    def test_completed_run_discards_private_data_and_preserves_evidence(self):
        self.finish()
        self.assertFalse((self.run/'private').exists())
        self.assertFalse((self.run/'lab.json').exists())
        self.assertTrue((self.run/'evidence/teardown.json').is_file())
        self.assertEqual(json.loads((self.run/'evidence/final-cleanup.json').read_text())['result'],'PASS')
    def test_failed_native_journey_finalizes_after_verified_shutdown(self):
        holder=Mock();holder.stdout.readline.return_value='{"ready":true}\n';holder.stdout.read.return_value='synthetic failure\n'
        with patch.object(lab.subprocess,'Popen',return_value=holder),patch.object(lab.select,'select',return_value=([holder.stdout],[],[])),patch.object(lab.subprocess,'run',return_value=Mock(returncode=1)),patch.object(lab,'down') as down:
            with self.assertRaisesRegex(RuntimeError,'desktop journey failed'):lab.desktop(self.run,'boundaries')
            down.assert_called_once_with(self.run);holder.wait.assert_called_once_with(timeout=10)
        self.assertFalse((self.run/'private').exists());self.assertFalse((self.run/'lab.json').exists())
        self.assertTrue((self.run/'evidence/final-cleanup.json').is_file())
    def test_failed_shutdown_preserves_native_journey_credentials_for_owned_retry(self):
        holder=Mock();holder.stdout.readline.return_value='{"ready":true}\n';holder.stdout.read.return_value=''
        with patch.object(lab.subprocess,'Popen',return_value=holder),patch.object(lab.select,'select',return_value=([holder.stdout],[],[])),patch.object(lab.subprocess,'run',return_value=Mock(returncode=1)),patch.object(lab,'down',side_effect=RuntimeError('shutdown refused')),patch.object(finalize,'finalize') as finish:
            with self.assertRaisesRegex(RuntimeError,'shutdown refused'):lab.desktop(self.run,'boundaries')
            holder.wait.assert_called_once_with(timeout=10);finish.assert_not_called()
        self.assert_preserved()
    def test_launcher_failure_before_manifest_keeps_original_failure(self):
        (self.run/'lab.json').unlink()
        holder=Mock();holder.stdout.readline.return_value='{"ready":false}\n';holder.stdout.read.return_value=''
        with patch.object(lab.subprocess,'Popen',return_value=holder),patch.object(lab.select,'select',return_value=([holder.stdout],[],[])),patch.object(finalize,'finalize') as finish:
            with self.assertRaisesRegex(RuntimeError,'did not report readiness'):lab.desktop(self.run,'boundaries')
            holder.terminate.assert_called_once();holder.wait.assert_called_once_with(timeout=10);finish.assert_not_called()
    def test_each_incomplete_receipt_refuses_cleanup(self):
        for field,value in [('process_groups_remaining',1),('runtime_exists',True)]:
            with self.subTest(field=field):
                old=self.receipt[field];self.receipt[field]=value;self.write()
                with self.assertRaises(RuntimeError):self.finish()
                self.assert_preserved();self.receipt[field]=old
        self.state['stopped']=False;self.write()
        with self.assertRaises(RuntimeError):self.finish()
        self.assert_preserved()
    def test_running_owned_group_refuses_even_with_success_receipt(self):
        child=subprocess.Popen([sys.executable,'-c','import time;time.sleep(30)'],start_new_session=True)
        try:
            self.state['processes']['server']={'pid':child.pid,'identity':lab.identity(child.pid),'argv':[str(self.run/'runtime/build/obsyncd'),'serve']}
            self.write()
            with self.assertRaises(RuntimeError):self.finish()
            self.assert_preserved()
        finally:
            child.terminate();child.wait(timeout=5)
    def test_live_holder_refuses_even_if_no_children(self):
        self.state['holder']={'pid':os.getpid(),'identity':lab.identity(os.getpid())};self.write()
        with self.assertRaises(RuntimeError):self.finish()
        self.assert_preserved()
    def test_runtime_link_is_never_followed(self):
        (self.run/'runtime').symlink_to(self.run/'private',target_is_directory=True)
        with self.assertRaises(RuntimeError):self.finish()
        self.assert_preserved()
    def test_private_link_is_never_followed(self):
        (self.run/'private').rename(self.run/'other')
        (self.run/'private').symlink_to(self.run/'other',target_is_directory=True)
        with self.assertRaises(RuntimeError):self.finish()
        self.assertTrue((self.run/'other/secret').is_file())
    def test_foreign_manifest_never_authorizes_deletion(self):
        self.state['run']=str(self.run/'other');self.write()
        with self.assertRaises(ValueError):self.finish()
        self.assert_preserved()
    def test_one_stop_error_does_not_skip_other_owned_processes(self):
        records=[{'pid':2001},{'pid':2002},{'pid':2003}]
        self.state['processes']=dict(zip(['server','A','B'],records))
        attempted=[]
        def stop(record):
            attempted.append(record['pid'])
            if record['pid']==2003:raise RuntimeError('synthetic refusal')
        with patch.object(lab,'stop',side_effect=stop):
            with self.assertRaises(RuntimeError):lab.down(self.run,self.state)
        self.assertEqual(attempted,[2003,2002,2001]);self.assert_preserved()
    def test_changed_process_identity_is_not_signalled(self):
        record={'pid':2001,'identity':'expected'}
        with patch.object(lab,'group_alive',return_value=True), patch.object(lab,'identity',return_value='different'), patch.object(lab,'reap'), patch.object(lab.os,'killpg') as kill:
            with self.assertRaises(RuntimeError):lab.stop(record)
            kill.assert_not_called()
    def test_unresolved_permission_denial_is_not_absence(self):
        with patch.object(lab,'reap'),patch.object(lab.os,'killpg',side_effect=PermissionError),patch.object(lab.time,'sleep'):
            with self.assertRaises(RuntimeError):lab.group_alive(2001)
    def test_exit_signal_race_requires_absence(self):
        with patch.object(lab,'group_alive',side_effect=[True,False]),patch.object(lab,'owned_identity',return_value='expected'),patch.object(lab.os,'killpg',side_effect=ProcessLookupError),patch.object(lab.time,'sleep'):
            lab.stop({'pid':2001,'identity':'expected'})

    def test_exit_before_final_signal_requires_absence(self):
        with patch.object(lab,'group_alive',side_effect=[True]*151+[False]),patch.object(lab,'owned_identity',return_value='expected'),patch.object(lab.os,'killpg',side_effect=[None,ProcessLookupError]) as kill,patch.object(lab.time,'sleep'):
            lab.stop({'pid':2001,'identity':'expected'})
            self.assertEqual(kill.call_count,2)

    def test_transient_exit_identity_requires_absence(self):
        record={'pid':2001,'identity':'expected'}
        with patch.object(lab,'reap'),patch.object(lab,'identity',side_effect=['exiting','exiting',None]),patch.object(lab.time,'sleep'):
            self.assertIsNone(lab.owned_identity(record))
        with patch.object(lab,'reap'),patch.object(lab,'identity',return_value='foreign'),patch.object(lab.time,'sleep'):
            with self.assertRaises(RuntimeError):lab.owned_identity(record)
    def test_wrapper_distinguishes_owned_and_explicit_fixtures(self):
        wrapper=Path(__file__).resolve().parents[4]/'test.py'
        # In the portable experiment the entry point lives beside scripts/.
        if not wrapper.exists():wrapper=Path(__file__).resolve().parents[3]/'test.py'
        for explicit in (False,True):
            args=[str(wrapper),'performance','--source',str(lab.REPO),'--run',str(self.run/'batch')]
            if explicit:args += ['--fixture',str(self.run/'caller')]
            with patch.object(sys,'argv',args),patch.object(subprocess,'run',return_value=Mock(returncode=0)) as run:
                with self.assertRaises(SystemExit) as result:runpy.run_path(str(wrapper),run_name='__main__')
                self.assertEqual(result.exception.code,0)
            command=run.call_args.args[0]
            self.assertEqual('--fixture' in command,explicit)
            if explicit:self.assertEqual(command[command.index('--fixture')+1],str(self.run/'caller'))

    def test_unmanifested_startup_residue_is_not_success(self):
        (self.run/'lab.json').unlink();(self.run/'runtime').mkdir()
        launcher=Mock()
        with self.assertRaises(RuntimeError):performance.finish_sample(self.run,launcher,None,Mock())
        launcher.terminate.assert_called_once();launcher.wait.assert_called_once()
        self.assertTrue((self.run/'runtime').exists());self.assertTrue((self.run/'private/secret').exists())
    def test_live_collector_still_attempts_app_and_holder_cleanup(self):
        collector=Mock();collector.is_alive.return_value=True
        launcher=Mock();stop=Mock()
        with patch.object(performance,'down') as down,patch.object(performance,'finalize') as finish:
            with self.assertRaises(RuntimeError):performance.finish_sample(self.run,launcher,collector,stop)
            down.assert_called_once_with(self.run);launcher.wait.assert_called_once_with(timeout=10)
            finish.assert_not_called();self.assert_preserved()
    def test_collector_join_error_still_attempts_process_cleanup(self):
        collector=Mock();collector.join.side_effect=RuntimeError('test');collector.is_alive.return_value=False
        launcher=Mock()
        with patch.object(performance,'down') as down,patch.object(performance,'finalize') as finish:
            with self.assertRaises(RuntimeError):performance.finish_sample(self.run,launcher,collector,Mock())
            down.assert_called_once_with(self.run);launcher.wait.assert_called_once();finish.assert_not_called()
    def test_down_error_still_attempts_holder_wait(self):
        launcher=Mock()
        with patch.object(performance,'down',side_effect=RuntimeError('test')),patch.object(performance,'finalize') as finish:
            with self.assertRaises(RuntimeError):performance.finish_sample(self.run,launcher,None,Mock())
            launcher.wait.assert_called_once();finish.assert_not_called()
    def test_owned_fixture_waits_for_successful_sample_cleanup(self):
        target=self.run/'fixture';record=fixture.create(target,2,reuse=False)
        result=performance.discard_generated_fixture(self.run,target,record,True,[{'cleanupCompleted':False}])
        self.assertFalse(result['removed']);self.assertEqual(fixture.verify(target),record)
        result=performance.discard_generated_fixture(self.run,target,record,True,[{'cleanupCompleted':True}])
        self.assertTrue(result['removed']);self.assertFalse(target.exists())
    def test_explicit_caller_fixture_is_preserved(self):
        target=self.run/'fixture';record=fixture.create(target,2,reuse=False)
        result=performance.discard_generated_fixture(self.run,target,record,False,[{'cleanupCompleted':True}])
        self.assertTrue(result['callerSuppliedFixturePreserved']);self.assertEqual(fixture.verify(target),record)
    def test_exclusive_generation_rejects_even_valid_existing_fixture(self):
        target=self.run/'fixture';record=fixture.create(target,2,reuse=False)
        with self.assertRaises(ValueError):fixture.create(target,2,reuse=False)
        self.assertEqual(fixture.verify(target),record)
    def test_changed_generated_fixture_is_preserved(self):
        target=self.run/'fixture';record=fixture.create(target,2,reuse=False)
        (target/'foreign').write_text('unexpected data')
        with self.assertRaises(ValueError):performance.discard_generated_fixture(self.run,target,record,True,[{'cleanupCompleted':True}])
        self.assertTrue((target/'foreign').is_file())

if __name__=='__main__':unittest.main()
