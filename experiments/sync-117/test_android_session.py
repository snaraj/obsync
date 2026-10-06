"""Safety refusals before any Android process or fixture can be created."""
import copy
import hashlib
import importlib.util
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

PATH = Path(__file__).with_name('android-session.py')
SPEC = importlib.util.spec_from_file_location('android_session', PATH)
SESSION = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(SESSION)


class AndroidPreflight(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='obsync-android-guard-')
        self.addCleanup(self.temp.cleanup)
        root = Path(self.temp.name)
        self.args = SimpleNamespace(seconds=3600, port=5584, run=root/'new-run',
            source=root/'source', apk=root/'official.apk', sdk=root/'sdk', java=root/'java')
        for p in [self.args.source/'AGENTS.md', self.args.apk,
                  self.args.sdk/'platform-tools/adb', self.args.sdk/'emulator/emulator',
                  self.args.sdk/'cmdline-tools/latest/bin/avdmanager', self.args.java/'bin/java']:
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_bytes(b'synthetic preflight fixture')
        self.args.apk_sha256 = hashlib.sha256(self.args.apk.read_bytes()).hexdigest()
        self.git = patch.object(SESSION.subprocess, 'check_output', return_value=b'').start()
        self.addCleanup(patch.stopall)

    def test_accepts_valid_inputs_without_creating_run(self):
        SESSION.validate(self.args)
        self.assertFalse(self.args.run.exists())

    def test_refuses_unbounded_duration(self):
        for seconds in (0, -1, 3601):
            with self.subTest(seconds=seconds):
                a = copy.copy(self.args); a.seconds = seconds
                with self.assertRaisesRegex(ValueError, 'duration'): SESSION.validate(a)

    def test_refuses_unsupported_console_port(self):
        for port in (5553, 5555, 5586):
            with self.subTest(port=port):
                a = copy.copy(self.args); a.port = port
                with self.assertRaisesRegex(ValueError, 'console port'): SESSION.validate(a)

    def test_preserves_existing_run(self):
        self.args.run.mkdir(); sentinel = self.args.run/'sentinel'; sentinel.write_text('keep')
        with self.assertRaisesRegex(ValueError, 'fresh external'): SESSION.validate(self.args)
        self.assertEqual(sentinel.read_text(), 'keep')

    def test_refuses_dangling_run_link(self):
        self.args.run.symlink_to(self.args.run.parent/'absent')
        with self.assertRaisesRegex(ValueError, 'fresh external'): SESSION.validate(self.args)
        self.assertTrue(self.args.run.is_symlink())

    def test_refuses_unidentified_source(self):
        (self.args.source/'AGENTS.md').unlink()
        with self.assertRaisesRegex(ValueError, 'candidate source'): SESSION.validate(self.args)

    def test_refuses_dirty_source(self):
        self.git.return_value = b' M plugin/src/main.ts\n'
        with self.assertRaisesRegex(ValueError, 'clean candidate'): SESSION.validate(self.args)

    def test_refuses_linked_apk(self):
        target = self.args.apk.with_suffix('.actual'); self.args.apk.rename(target)
        self.args.apk.symlink_to(target)
        with self.assertRaisesRegex(ValueError, 'regular verified'): SESSION.validate(self.args)

    def test_refuses_missing_apk(self):
        self.args.apk.unlink()
        with self.assertRaisesRegex(ValueError, 'regular verified'): SESSION.validate(self.args)

    def test_refuses_changed_apk(self):
        self.args.apk.write_bytes(b'altered artifact')
        with self.assertRaisesRegex(ValueError, 'digest mismatch'): SESSION.validate(self.args)

    def test_refuses_missing_tool(self):
        (self.args.sdk/'platform-tools/adb').unlink()
        with self.assertRaisesRegex(ValueError, 'tooling required'): SESSION.validate(self.args)


if __name__ == '__main__':
    unittest.main()
