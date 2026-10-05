"""Offline launch refusals and independent expiry; never creates a network listener."""
import importlib.util
import json
import os
import shutil
import runpy
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parent
SOURCE = Path(os.environ['OBSYNC_LAB_SOURCE'])
PREFLIGHT = Path(os.environ['OBSYNC_PHONE_PREFLIGHT'])
ARCHIVE = json.loads((PREFLIGHT / 'preflight.json').read_text())['fixtureVault'] + '.zip'
spec = importlib.util.spec_from_file_location('phone_session', ROOT / 'phone-session.py')
session = importlib.util.module_from_spec(spec)
spec.loader.exec_module(session)

class PreflightTests(unittest.TestCase):
    def test_copy_failure_removes_prepared_fixture(self):
        with tempfile.TemporaryDirectory(prefix='phone-copy-') as temp:
            run = Path(temp) / 'prepared'
            with patch.object(sys, 'argv', ['phone-preflight.py', '--source', str(SOURCE), '--run', str(run)]), \
                 patch('shutil.copy2', side_effect=OSError('injected copy failure')):
                with self.assertRaises(OSError):
                    runpy.run_path(str(ROOT / 'phone-preflight.py'), run_name='__main__')
            self.assertFalse(run.exists())

    def test_changed_server_copy_removes_prepared_fixture(self):
        with tempfile.TemporaryDirectory(prefix='phone-copy-') as temp:
            run = Path(temp) / 'prepared'
            def corrupt(source, destination):
                Path(destination).write_bytes(b'injected wrong bytes')
            with patch.object(sys, 'argv', ['phone-preflight.py', '--source', str(SOURCE), '--run', str(run)]), \
                 patch('shutil.copy2', side_effect=corrupt):
                with self.assertRaisesRegex(ValueError, 'server changed while copying'):
                    runpy.run_path(str(ROOT / 'phone-preflight.py'), run_name='__main__')
            self.assertFalse(run.exists())

    def test_candidate_version_mismatch_leaves_no_preflight(self):
        with tempfile.TemporaryDirectory(prefix='phone-version-') as temp:
            source = Path(temp) / 'source'
            subprocess.run(['git', 'clone', '--quiet', '--shared', str(SOURCE), str(source)], check=True)
            artifacts = source / 'plugin/dist'
            artifacts.mkdir(parents=True, exist_ok=True)
            for name in ('main.js', 'manifest.json', 'styles.css'):
                shutil.copy2(SOURCE / 'plugin/dist' / name, artifacts / name)
            manifest = json.loads((artifacts / 'manifest.json').read_text())
            manifest['version'] = '0.0.0'
            (artifacts / 'manifest.json').write_text(json.dumps(manifest))
            binary = source / 'target/release/obsyncd'
            binary.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(PREFLIGHT / 'obsyncd', binary)
            run = Path(temp) / 'prepared'
            result = subprocess.run([sys.executable, '-B', str(ROOT / 'phone-preflight.py'),
                '--source', str(source), '--run', str(run)], capture_output=True, text=True, timeout=10)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn('unexpected candidate manifest', result.stderr)
            self.assertFalse(run.exists())

    def refused(self, change):
        with tempfile.TemporaryDirectory(prefix='phone-refusal-') as temp:
            root = Path(temp)
            prepared = root / 'prepared'
            prepared.mkdir()
            for name in ('preflight.json', 'obsyncd', ARCHIVE):
                (prepared / name).write_bytes((PREFLIGHT / name).read_bytes())
            change(prepared)
            run = root / 'run'
            result = subprocess.run([sys.executable, '-B', str(ROOT / 'phone-session.py'),
                '--source', str(SOURCE), '--preflight', str(prepared), '--run', str(run)],
                capture_output=True, text=True, timeout=10)
            self.assertEqual(result.returncode, 1)
            self.assertEqual(json.loads(result.stdout)['exceptionType'], 'ValueError')
            self.assertFalse(run.exists())
            self.assertFalse((root / 'run-inputs').exists())

    def test_corrupt_server_refused_before_runtime(self):
        self.refused(lambda p: (p / 'obsyncd').write_bytes(b'invalid'))

    def test_corrupt_zip_refused_before_runtime(self):
        self.refused(lambda p: (p / ARCHIVE).write_bytes(b'invalid'))

    def test_stale_source_refused_before_runtime(self):
        def change(p):
            record = json.loads((p / 'preflight.json').read_text())
            record['sourceHead'] = '0' * 40
            (p / 'preflight.json').write_text(json.dumps(record))
        self.refused(change)

    def test_foreign_fixture_name_refused_before_runtime(self):
        def change(p):
            record = json.loads((p / 'preflight.json').read_text())
            record['fixtureVault'] = '../foreign'
            (p / 'preflight.json').write_text(json.dumps(record))
        self.refused(change)

    def test_wrong_plugin_hash_removes_partial_inputs(self):
        def change(p):
            record = json.loads((p / 'preflight.json').read_text())
            record['pluginHashes']['styles.css'] = '0' * 64
            (p / 'preflight.json').write_text(json.dumps(record))
        self.refused(change)

    def test_foreign_plugin_name_refused_before_inputs(self):
        def change(p):
            record = json.loads((p / 'preflight.json').read_text())
            record['pluginHashes']['../foreign'] = '0' * 64
            (p / 'preflight.json').write_text(json.dumps(record))
        self.refused(change)

    def test_expiry_terminates_owned_child_without_main_driver(self):
        child = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(30)'])
        stop = threading.Event()
        calls = []
        def terminate():
            calls.append('expired')
            child.terminate()
            child.wait(timeout=2)
        watcher = threading.Thread(target=session.watch_expiry,
            args=(stop, lambda: time.monotonic() - 1, terminate))
        try:
            watcher.start()
            watcher.join(timeout=2)
            self.assertFalse(watcher.is_alive())
            self.assertTrue(stop.is_set())
            self.assertEqual(calls, ['expired'])
            self.assertIsNotNone(child.poll())
        finally:
            stop.set()
            if child.poll() is None:
                child.terminate()
                child.wait(timeout=2)
            watcher.join(timeout=2)

    def test_no_deadline_does_not_expire_preparation(self):
        stop = threading.Event()
        calls = []
        watcher = threading.Thread(target=session.watch_expiry,
            args=(stop, lambda: None, lambda: calls.append('expired')))
        watcher.start()
        time.sleep(.25)
        self.assertTrue(watcher.is_alive())
        stop.set()
        watcher.join(timeout=2)
        self.assertFalse(watcher.is_alive())
        self.assertEqual(calls, [])

if __name__ == '__main__':
    unittest.main()
