"""A failed fixture is not proof that an E2EE behavior mutant was killed."""
import contextlib
import importlib.util
import io
from pathlib import Path
import subprocess
import unittest


path = Path(__file__).resolve().parents[1] / 'validation/e2ee_mutations.py'
spec = importlib.util.spec_from_file_location('e2ee_mutations', path)
mutations = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mutations)


class IntendedMutationFailure(unittest.TestCase):
    def test_unrelated_failures_never_count_as_resume_kills(self):
        target = 'explicit resume clears the hold'
        assertion = 'AssertionError [ERR_ASSERTION]: '
        failures = [
            'Error: recorder_failed',
            'Error: ' + assertion + target,
            assertion + 'fixture server exited before readiness',
            assertion + 'request must have a definite result',
            assertion + 'restored-copy recipient readback',
            assertion + 'unrelated failure mentioning ' + target,
            assertion + target + ' is merely quoted by an unrelated failure',
            assertion + 'fixture server exited before readiness\n' + assertion + target,
        ]
        for stderr in failures:
            with self.subTest(stderr=stderr), self.assertRaises(SystemExit):
                mutations.engine_kill('pause_resume', subprocess.CompletedProcess([], 1, '', stderr), (target,))
        with self.assertRaises(SystemExit):
            mutations.engine_kill('pause_resume', subprocess.CompletedProcess([], 0, '', assertion + target), (target,))

    def test_behavior_assertion_survives_secondary_cleanup_failure(self):
        stderr = ('e2ee cleanup=fail reason=shutdown_failed\n'
                  'AssertionError [ERR_ASSERTION]: explicit resume clears the hold\n'
                  'actual: NEVER_PUBLISH_SYNTHETIC_VALUE\n')
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            mutations.engine_kill('pause_resume', subprocess.CompletedProcess([], 1, '', stderr),
                                  ('explicit resume clears the hold',))
        self.assertIn('decision=killed', output.getvalue())
        self.assertNotIn('NEVER_PUBLISH', output.getvalue())


if __name__ == '__main__':
    unittest.main()
