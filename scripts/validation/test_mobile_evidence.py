import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('mobile_evidence', Path(__file__).with_name('mobile-evidence.py'))
oracle = importlib.util.module_from_spec(spec)
spec.loader.exec_module(oracle)


class EvidenceTests(unittest.TestCase):
    def test_detects_independent_data_loss_controls(self):
        content = b'nonempty synthetic sentinel\n'
        self.assertEqual(oracle.compare(content, content, content)['bytes'], len(content))
        for desktop, android in [(b'', b''), (content, b''), (b'', content), (content[:-1], content[:-1]), (content, content + b'wrong')]:
            with self.subTest(desktop=desktop, android=android), self.assertRaises(ValueError):
                oracle.compare(content, desktop, android)

    def test_missing_evidence_cannot_pass(self):
        for value in [[], None, [{'path': 'note.md', 'text': ''}]]:
            with self.subTest(value=value), self.assertRaises((ValueError, TypeError)):
                oracle.fixtures(value)
        with self.assertRaises(ValueError):
            oracle.compare(b'', b'', b'')

    def test_broken_controls_run_against_actual_exports_and_detect_disabled_oracle(self):
        content=b'actual exported synthetic note\n'
        self.assertEqual(len(oracle.broken_controls(content,content,content)),6)
        with patch.object(oracle,'compare',return_value={}):
            with self.assertRaisesRegex(RuntimeError,'control survived'):
                oracle.broken_controls(content,content,content)

    def test_owned_expected_paths(self):
        self.assertEqual(len(oracle.fixtures([{'path': 'Team docs/One.md', 'text': 'x'}])), 1)
        self.assertEqual(len(oracle.fixtures([{'path': 'Original (restored-'+'ab'*16+').md', 'text': 'x'}])), 1)
        for path in ['../secret.md', '/note.md', '.obsidian/x.md', 'Team/../../note.md', 'note.md;id', 'Original (restored-x).md', 'Original (copy).md', 'A/B/C/D/E.md']:
            with self.subTest(path=path), self.assertRaises(ValueError):
                oracle.fixtures([{'path': path, 'text': 'x'}])


if __name__ == '__main__':
    unittest.main()
