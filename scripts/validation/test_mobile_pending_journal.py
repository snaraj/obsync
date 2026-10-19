"""Whole durable journal coverage for pending-rotation restart checkpoints."""
import ast
import hashlib
import importlib.util
import json
from pathlib import Path
import struct
import tempfile
import unittest
from unittest.mock import patch
from types import SimpleNamespace
import time
import zlib

HERE = Path(__file__).resolve().parent

def load(name):
    spec = importlib.util.spec_from_file_location(name, HERE / (name + '.py'))
    module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module); return module
F, J = load('mobile-full'), load('mobile-journal')

def frame(kind, seq):
    value = json.dumps({'t': kind, 's': seq}).encode()
    return struct.pack('<II', len(value), zlib.crc32(value)) + value


class PendingJournal(unittest.TestCase):
    def baseline(self, directory):
        path = directory / '000000.log'; path.write_bytes(frame('suite2_setup', 1)); path.chmod(0o600)
        return path

    def snapshot(self, directory):
        return {**J.read_segments(directory), 'sourceHead': 'a' * 40,
                'serverArtifactSha256': 'b' * 64, 'serverIdentitySha256': 'c' * 64}

    def test_exact_whole_journal_passes_and_unqueried_file_write_is_detected(self):
        with tempfile.TemporaryDirectory(prefix='obsync-pending-journal-') as tmp:
            directory = Path(tmp).resolve(); path = self.baseline(directory); before = self.snapshot(directory)
            F.assert_pending_journal(before, self.snapshot(directory))
            for kind in ('version', 'device', 'rotation_transfer'):
                path.write_bytes(frame('suite2_setup', 1) + frame(kind, 2))
                with self.assertRaisesRegex(ValueError, 'whole verified journal'):
                    F.assert_pending_journal(before, self.snapshot(directory))

    def test_missing_added_segment_corruption_or_foreign_binding_cannot_pass(self):
        with tempfile.TemporaryDirectory(prefix='obsync-pending-journal-') as tmp:
            directory = Path(tmp).resolve(); path = self.baseline(directory); before = self.snapshot(directory)
            extra = directory / '000001.log'; extra.write_bytes(frame('version', 2)); extra.chmod(0o600)
            with self.assertRaises(ValueError): F.assert_pending_journal(before, self.snapshot(directory))
            extra.unlink(); path.write_bytes(b'partial')
            with self.assertRaises(ValueError): self.snapshot(directory)
            for field in ('segments', 'sourceHead', 'serverArtifactSha256', 'serverIdentitySha256'):
                wrong = {**before, field: None}
                with self.assertRaises((ValueError, TypeError)): F.assert_pending_journal(before, wrong)
            with self.assertRaises(ValueError): F.assert_pending_journal({}, {})

    def test_equality_mutant_is_killed_by_unseen_write(self):
        source = (HERE / 'mobile-full.py').read_text()
        start = source.index('def assert_pending_journal('); end = source.index('\n\ndef ', start + 4)
        snippet = source[start:end]
        self.assertIn('or before != after', snippet)
        namespace = {'re': __import__('re')}
        exec(snippet.replace('or before != after', ''), namespace)
        with tempfile.TemporaryDirectory(prefix='obsync-pending-mutant-') as tmp:
            directory = Path(tmp).resolve(); path = self.baseline(directory); before = self.snapshot(directory)
            path.write_bytes(frame('suite2_setup', 1) + frame('version', 2)); after = self.snapshot(directory)
            namespace['assert_pending_journal'](before, after)
            with self.assertRaises(ValueError): F.assert_pending_journal(before, after)

    def test_snapshot_binds_live_holder_server_source_and_binary_before_reading(self):
        with tempfile.TemporaryDirectory(prefix='obsync-pending-binding-') as tmp:
            run = Path(tmp).resolve(); directory = run / 'runtime/server/journal/v1/journal'
            directory.mkdir(parents=True); self.baseline(directory)
            (run / 'runtime/build').mkdir(); binary = run / 'runtime/build/obsyncd'; binary.write_bytes(b'owned synthetic binary')
            state = {'format': 1, 'run': str(run), 'source_dirty': False, 'source_head': 'a' * 40,
                     'expiresAtEpoch': time.time() + 60, 'holder': {'pid': 123, 'identity': 'holder'},
                     'processes': {'server': {'pid': 456, 'identity': 'server', 'argv': [str(binary), 'serve']}},
                     'artifacts': {'obsyncd': hashlib.sha256(binary.read_bytes()).hexdigest()}}
            loader = SimpleNamespace(loader=SimpleNamespace(exec_module=lambda _: None))
            with patch.object(F.importlib.util, 'spec_from_file_location', return_value=loader), \
                 patch.object(F.importlib.util, 'module_from_spec', return_value=J), \
                 patch.object(J.SESSION, 'private_json', side_effect=lambda _: state), \
                 patch.object(J.COMMON, 'identity', side_effect=lambda pid: {123: 'holder', 456: 'server'}[pid]):
                self.assertEqual(F.pending_journal(run, 'a' * 40)['frameCounts'], {'suite2_setup': 1})
                with self.assertRaises(ValueError): F.pending_journal(run, 'f' * 40)
                state['holder']['identity'] = 'changed'
                with self.assertRaises(ValueError): F.pending_journal(run, 'a' * 40)
                state['holder']['identity'] = 'holder'; state['processes']['server']['argv'][1] = 'foreign'
                with self.assertRaises(ValueError): F.pending_journal(run, 'a' * 40)
                state['processes']['server']['argv'][1] = 'serve'; binary.write_bytes(b'changed')
                with self.assertRaises(ValueError): F.pending_journal(run, 'a' * 40)

    def test_real_sequence_brackets_each_pending_restart_with_independent_journal(self):
        tree = ast.parse((HERE / 'mobile-full.py').read_text())
        run = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == 'run')
        statements = [ast.unparse(n) for n in run.body]
        for label, phase, variable, before_name, after_name in (
            ('prepared', 'prepared', 'prepared_journal', 'prepared-before-restart', 'prepared-after-restart'),
            ('commit-unknown', 'commit_unknown', 'commit_journal', 'commit-unknown-before-restart', 'commit-unknown-after-restart')):
            position = statements.index(f"restart_desktop('{label}', '{phase}')")
            self.assertEqual(statements[position - 1], f"{variable} = pending_journal(desktop, c['sourceHead'])")
            self.assertIn(before_name, statements[position - 2])
            self.assertIn(after_name, statements[position + 1])
            self.assertEqual(statements[position + 2], f"assert_pending_journal({variable}, pending_journal(desktop, c['sourceHead']))")
        self.assertIn('wholeJournalUnchangedAcrossBothRestarts=True', '\n'.join(statements))

if __name__ == '__main__': unittest.main()
