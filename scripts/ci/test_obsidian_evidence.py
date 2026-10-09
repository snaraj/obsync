"""Run the native driver's privacy and credential-evidence refusal controls."""
from pathlib import Path
import subprocess
import unittest


class ObsidianEvidence(unittest.TestCase):
    def test_reduced_custody_and_capture_refusals(self):
        result = subprocess.run(
            ["node", "--test", str(Path(__file__).with_name("obsidian-evidence.test.mjs"))],
            capture_output=True, text=True, check=False,
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
