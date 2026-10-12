"""Run the native driver's privacy and credential-evidence refusal controls."""
from pathlib import Path
import subprocess
import unittest
from miniyaml import loads


class ObsidianEvidence(unittest.TestCase):
    def test_macos_job_requires_native_encrypted_restart(self):
        workflow = Path(__file__).resolve().parents[2] / '.github/workflows/desktop-matrix.yml'
        document, = loads(workflow.read_text())
        job = document['jobs']['obsidian-macos']
        self.assertEqual(job['runs-on'], 'macos-15')
        self.assertEqual(job['env'].get('OBSYNC_E2E_SECRET_STORE'), 'macos')
        self.assertEqual(job['strategy']['matrix']['launch-order'], ['simultaneous', 'serialized'])
        self.assertFalse(job['strategy']['fail-fast'])
        self.assertEqual(job['env'].get('OBSYNC_E2E_LAUNCH_ORDER'), '${{ matrix.launch-order }}')
        self.assertTrue(job['env']['OBSYNC_E2E_RUN_ID'].endswith('-macos-${{ matrix.launch-order }}'))
        steps = [step for step in job['steps'] if 'scripts/ci/obsidian-host.sh' in step.get('run', '')]
        self.assertEqual(len(steps), 1)
        self.assertNotIn('if', job)
        self.assertNotIn('if', steps[0])
        self.assertNotIn('OBSYNC_E2E_SECRET_STORE', steps[0].get('env', {}))
        self.assertEqual(steps[0]['run'], 'scripts/ci/obsidian-host.sh "${GITHUB_WORKSPACE}/target/release/obsyncd"')
        self.assertFalse(job.get('continue-on-error', False))
        self.assertFalse(steps[0].get('continue-on-error', False))

    def test_reduced_custody_and_capture_refusals(self):
        result = subprocess.run(
            ["node", "--test", str(Path(__file__).with_name("obsidian-evidence.test.mjs"))],
            capture_output=True, text=True, check=False,
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
