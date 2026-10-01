"""A mutation runner's KILLED means the mutant was caught (review of 1cc99e32).

The cargo runners under scripts/validation counted any failing run as a kill,
so a sandbox whose listener could not bind reported every probe killed. These
tests hold the shared judge (scripts/validation/kills.py) to that case and its
neighbours, and pin that every runner mutating Rust source is judged by it.
"""

import json
import re
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[2]
VALIDATION = ROOT / "scripts" / "validation"
sys.path.insert(0, str(VALIDATION))
import kills  # noqa: E402

TEST = "api::server_test::the_device_list_counts_active_pending_and_revoked"


def failing(test, at, message):
    # This toolchain's shape: the thread id after the name, and a helper
    # thread's own panic before the test's.
    return 101, (f"running 1 test\n---- {test} stdout ----\n\n"
                 "thread '<unnamed>' (45499458) panicked at crates/obsyncd/src/api/auth.rs:279:27:\nhelper\n"
                 f"thread '{test}' (45499456) panicked at {at}:\n{message}\n"
                 "note: run with `RUST_BACKTRACE=1` environment variable to display a backtrace\n\n"
                 f"failures:\n    {test}\n\n"
                 "test result: FAILED. 0 passed; 1 failed; 0 ignored; 0 measured; 506 filtered out\n")


SETUP = failing(TEST, "crates/obsyncd/src/api/server_test.rs:229:42",
                'bind a loopback port: Os { code: 1, kind: PermissionDenied, message: "Operation not permitted" }')
ASSERTION = failing(TEST, "crates/obsyncd/src/api/server_test.rs:5584:5",
                    "assertion `left == right` failed: the pending device is counted\n  left: 1\n right: 2")
PASSES = (0, "running 1 test\ntest " + TEST + " ... ok\n\n"
          "test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 506 filtered out\n")
SELECTS_NOTHING = (0, "running 0 tests\n\ntest result: ok. 0 passed; 0 failed; 0 ignored\n")


class Verdicts(unittest.TestCase):
    def test_a_setup_failure_the_unmutated_binary_shares_is_an_error_not_a_kill(self):
        # The review's case: no loopback, so the mutant and the baseline both
        # stop at the listener before any assertion runs.
        verdict, why = kills.classify(SETUP, SETUP, SETUP)
        self.assertEqual(verdict, "ERROR")
        self.assertIn("server_test.rs:229", why)

    def test_an_assertion_that_repeats_against_a_passing_baseline_is_a_kill_with_its_evidence(self):
        verdict, evidence = kills.classify(ASSERTION, ASSERTION, PASSES)
        self.assertEqual(verdict, "KILLED")
        self.assertIn(TEST, evidence)
        self.assertIn("server_test.rs:5584:5", evidence)
        self.assertIn("assertion `left == right` failed", evidence)

    def test_a_failure_that_does_not_repeat_is_an_error(self):
        self.assertEqual(kills.classify(ASSERTION, PASSES, PASSES)[0], "ERROR")
        other = failing("storage::tests::another", "crates/obsyncd/src/storage/tests.rs:9:1", "x")
        self.assertEqual(kills.classify(ASSERTION, other, PASSES)[0], "ERROR")

    def test_a_baseline_that_selects_no_test_cannot_judge(self):
        self.assertEqual(kills.classify(ASSERTION, ASSERTION, SELECTS_NOTHING)[0], "ERROR")

    def test_a_failure_with_no_panic_is_an_error(self):
        harness = (101, "error: test failed, to rerun pass `--lib`\nCaused by: process didn't exit successfully\n")
        self.assertEqual(kills.classify(harness, None, None)[0], "ERROR")

    def test_a_mutant_that_does_not_compile_or_passes_is_not_a_kill(self):
        self.assertEqual(kills.classify((101, "error: could not compile `obsyncd`"), None, None)[0], "NOT A KILL")
        self.assertEqual(kills.classify(PASSES, None, None)[0], "NOT A KILL")


class Judge(unittest.TestCase):
    def test_a_baseline_that_fails_here_refuses_the_whole_run_before_any_mutation(self):
        # The benign negative control: nothing is mutated, setup fails, and
        # the runner cannot start, so it cannot print a successful summary.
        with tempfile.TemporaryDirectory() as scratch:
            binary = Path(scratch) / "obsyncd-test"
            binary.write_bytes(b"")
            artifact = json.dumps({
                "reason": "compiler-artifact", "executable": str(binary),
                "profile": {"test": True}, "target": {"kind": ["lib"]},
                "manifest_path": str(ROOT / "crates" / "obsyncd" / "Cargo.toml"),
            })

            def fake(command, **_):
                if "--no-run" in command:
                    return mock.Mock(returncode=0, stdout=artifact + "\n")
                return mock.Mock(returncode=SETUP[0], stdout=SETUP[1])

            with mock.patch.object(kills.subprocess, "run", side_effect=fake):
                with self.assertRaises(SystemExit) as refused:
                    kills.Judge({("obsyncd", TEST)})
        self.assertTrue(str(refused.exception).startswith("ERROR"), refused.exception)
        self.assertIn("server_test.rs:229", str(refused.exception))

    def test_every_rust_runner_is_judged_by_the_shared_judge(self):
        runners = {path.stem: path.read_text() for path in VALIDATION.glob("*_mutations.py")}
        judged = {name for name, text in runners.items() if "Judge(" in text}
        rust = []
        for name, text in sorted(runners.items()):
            self.assertFalse('"FAILED" in' in text, f"{name} counts any failing run as a kill")
            self.assertFalse('"cargo", "test"' in text, f"{name} runs cargo test itself, not through the judge")
            if '.rs"' in text:
                rust.append(name)
                borrowed = set(re.findall(r"^from (\w+) import run$", text, re.M))
                self.assertTrue("Judge(" in text or borrowed & judged,
                                f"{name} mutates Rust source without the shared judge")
        self.assertTrue(rust, "no runner mutates Rust source, so this test checks nothing")


if __name__ == "__main__":
    unittest.main()
