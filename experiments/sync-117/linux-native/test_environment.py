"""Hostile inherited session state must not escape the disposable profile."""
import importlib.util
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('linux_native', Path(__file__).with_name('run.py'))
driver = importlib.util.module_from_spec(spec)
spec.loader.exec_module(driver)


class ProfileIsolation(unittest.TestCase):
    def test_inherited_paths_and_session_controls_cannot_escape(self):
        with tempfile.TemporaryDirectory() as scratch:
            root = Path(scratch)
            run, outside = root / 'run', root / 'caller'
            profile = run / 'runtime/A/userdata'
            profile.mkdir(parents=True)
            outside.mkdir()
            marker = outside / 'preserved'
            marker.write_text('caller-owned sentinel')
            hostile = dict(os.environ, OBSYNC_LINUX_RUN=str(run), OBSYNC_LINUX_APP='/owned/app',
                           OBSYNC_LAB_SOURCE='/owned/source', HOME=str(outside), DISPLAY=':99',
                           XDG_DATA_HOME=str(outside), XDG_CONFIG_HOME=str(outside),
                           XDG_CACHE_HOME=str(outside), XDG_STATE_HOME=str(outside),
                           XDG_RUNTIME_DIR=str(outside), OBSYNC_E2E_SESSION_BUS='1',
                           OBSYNC_E2E_KEYRING_PASSWORD=str(outside / 'preserved'),
                           DBUS_SESSION_BUS_ADDRESS='unix:path=/caller/bus',
                           DBUS_SESSION_BUS_PID='999999', GNOME_KEYRING_CONTROL='/caller/control',
                           GNOME_KEYRING_PID='999998')
            called = []

            def start(_argv, *, env):
                called.append(True)
                self.assertNotIn('OBSYNC_E2E_SESSION_BUS', env)
                self.assertNotIn('XDG_RUNTIME_DIR', env)
                self.assertFalse(any(k.startswith(('DBUS_', 'GNOME_KEYRING_')) for k in env))
                self.assertEqual(env['DISPLAY'], ':99')
                home = profile / 'home'
                self.assertEqual(Path(env['HOME']), home)
                for key in ['XDG_DATA_HOME', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME']:
                    target = Path(env[key])
                    target.mkdir(parents=True, exist_ok=True)
                    (target / 'write-probe').write_text('task sentinel')
                    self.assertTrue(target.is_relative_to(home))
                password = Path(env['OBSYNC_E2E_KEYRING_PASSWORD'])
                self.assertTrue(password.is_relative_to(home))
                self.assertEqual(password.stat().st_mode & 0o777, 0o600)
                return 0

            previous = os.umask(0o077)
            try:
                with patch.dict(os.environ, hostile, clear=True), patch.object(driver.sys, 'argv',
                     ['run.py', '--user-data-dir=' + str(profile)]), patch.object(driver.subprocess, 'call', start):
                    self.assertEqual(driver.session(), 0)
            finally:
                os.umask(previous)
            self.assertEqual(called, [True])
            self.assertEqual(list(outside.iterdir()), [marker])
            self.assertEqual(marker.read_text(), 'caller-owned sentinel')

    def test_foreign_profile_is_refused_before_launch(self):
        with tempfile.TemporaryDirectory() as scratch:
            root = Path(scratch)
            foreign = root / 'foreign'
            foreign.mkdir()
            with patch.dict(os.environ, {'OBSYNC_LINUX_RUN': str(root / 'run')}), \
                 patch.object(driver.sys, 'argv', ['run.py', '--user-data-dir=' + str(foreign)]), \
                 patch.object(driver.subprocess, 'call') as start:
                with self.assertRaises(AssertionError):
                    driver.session()
                start.assert_not_called()
            self.assertEqual(list(foreign.iterdir()), [])


if __name__ == '__main__':
    unittest.main()
