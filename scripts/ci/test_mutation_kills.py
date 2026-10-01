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


SERVER_TEST = "crates/obsyncd/src/api/server_test.rs"
SETUP_AT = f"{SERVER_TEST}:229:58"
ASSERT_AT = f"{SERVER_TEST}:5584:5"
OTHER_ASSERT_AT = f"{SERVER_TEST}:5597:5"
# The source at each fixture site, as Rust reports it: an `.expect` at its
# method name, an assertion at its macro.
SOURCE = {SETUP_AT: 'expect("bind");', ASSERT_AT: "assert_eq!(", OTHER_ASSERT_AT: "assert_eq!(",
          "crates/obsyncd/src/api/server_test.rs:40:9": 'panic!("sentinel");'}
SETUP = failing(TEST, SETUP_AT,
                'bind: Os { code: 1, kind: PermissionDenied, message: "Operation not permitted" }')
ASSERTION = failing(TEST, ASSERT_AT,
                    "assertion `left == right` failed: the pending device is counted\n  left: 1\n right: 2")
PASSES = (0, "running 1 test\ntest " + TEST + " ... ok\n\n"
          "test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 506 filtered out\n")
SELECTS_NOTHING = (0, "running 0 tests\n\ntest result: ok. 0 passed; 0 failed; 0 ignored\n")


def classify(first, again, baseline):
    return kills.classify(first, again, baseline, source=lambda site: SOURCE.get(site, ""))


class Verdicts(unittest.TestCase):
    def test_a_setup_failure_the_unmutated_binary_shares_is_an_error_not_a_kill(self):
        # The review's case: no loopback, so the mutant and the baseline both
        # stop at the listener before any assertion runs.
        verdict, why = classify(SETUP, SETUP, SETUP)
        self.assertEqual(verdict, "ERROR")
        self.assertIn("server_test.rs:229", why)

    def test_a_setup_failure_is_an_error_even_when_the_baseline_passes(self):
        # The second review's case: a passing baseline before or after a
        # transient setup failure does not make that failure an assertion.
        verdict, why = classify(SETUP, SETUP, PASSES)
        self.assertEqual(verdict, "ERROR")
        self.assertIn("not at an assertion", why)

    def test_an_assertion_that_repeats_against_a_passing_baseline_is_a_kill_with_its_evidence(self):
        verdict, evidence = classify(ASSERTION, ASSERTION, PASSES)
        self.assertEqual(verdict, "KILLED")
        self.assertIn(TEST, evidence)
        self.assertIn("server_test.rs:5584:5", evidence)
        self.assertIn("assertion `left == right` failed", evidence)

    def test_a_failure_that_does_not_repeat_where_it_failed_is_an_error(self):
        self.assertEqual(classify(ASSERTION, PASSES, PASSES)[0], "ERROR")
        other = failing("storage::tests::another", "crates/obsyncd/src/storage/tests.rs:9:1", "x")
        self.assertEqual(classify(ASSERTION, other, PASSES)[0], "ERROR")
        # The second review's case: the same test, its repeat stopped at setup.
        self.assertEqual(classify(ASSERTION, SETUP, PASSES)[0], "ERROR")
        # The same test at another assertion is not the same failure either.
        elsewhere = failing(TEST, OTHER_ASSERT_AT, "assertion `left == right` failed: a revoked device is not")
        self.assertEqual(classify(ASSERTION, elsewhere, PASSES)[0], "ERROR")

    def test_the_last_panic_on_the_tests_own_thread_decides(self):
        caught = "thread '" + TEST + "' (45499456) panicked at crates/obsyncd/src/api/server_test.rs:40:9:\nsentinel\n"
        setup_after_sentinel = (SETUP[0], SETUP[1].replace("thread '<unnamed>'", caught + "thread '<unnamed>'"))
        self.assertEqual(classify(setup_after_sentinel, setup_after_sentinel, PASSES)[0], "ERROR")
        caught = "thread '" + TEST + "' (45499456) panicked at " + SETUP_AT + ":\nbind\n"
        assertion_after_setup = (ASSERTION[0], ASSERTION[1].replace("thread '<unnamed>'", caught + "thread '<unnamed>'"))
        self.assertEqual(classify(assertion_after_setup, assertion_after_setup, PASSES)[0], "KILLED")

    def test_an_expect_counts_only_as_a_verdict_its_own_test_lists(self):
        listed = "storage::tests::only_a_revoked_device_is_archived_and_the_record_survives"
        at = "crates/obsyncd/src/storage/tests.rs:3132:14"
        source = {at: 'expect_err("only a revoked device is archived");'}

        def judge(test, message, site=at, text=source):
            run = failing(test, site, message)
            return kills.classify(run, run, PASSES, source=lambda s: text.get(s, ""))[0]

        self.assertEqual(judge(listed, "only a revoked device is archived: ()"), "KILLED")
        # The same words in another test, a test's other `.expect`, the words
        # run on, or the words at a site that is not an `expect`: none counts.
        self.assertEqual(judge(TEST, "only a revoked device is archived: ()"), "ERROR")
        self.assertEqual(judge(listed, "setup runs once: Io"), "ERROR")
        self.assertEqual(judge(listed, "only a revoked device is archived twice"), "ERROR")
        self.assertEqual(judge(listed, "only a revoked device is archived: ()",
                               text={at: "archive_device(&id)"}), "ERROR")

    def test_a_baseline_that_selects_no_test_cannot_judge(self):
        self.assertEqual(classify(ASSERTION, ASSERTION, SELECTS_NOTHING)[0], "ERROR")

    def test_a_failure_with_no_panic_is_an_error(self):
        harness = (101, "error: test failed, to rerun pass `--lib`\nCaused by: process didn't exit successfully\n")
        self.assertEqual(classify(harness, None, None)[0], "ERROR")
        silent = (101, f"running 1 test\n---- {TEST} stdout ----\nnote: test did not panic as expected\n")
        self.assertEqual(classify(silent, silent, PASSES)[0], "ERROR")

    def test_a_mutant_that_does_not_compile_or_passes_is_not_a_kill(self):
        self.assertEqual(classify((101, "error: could not compile `obsyncd`"), None, None)[0], "NOT A KILL")
        self.assertEqual(classify(PASSES, None, None)[0], "NOT A KILL")

    def test_the_real_listener_setup_is_not_an_assertion_and_a_real_assertion_is(self):
        # The same judgement against this repository's own source, read where
        # Rust reports each panic: so the fixtures above cannot drift from it.
        lines = (ROOT / SERVER_TEST).read_text().splitlines()
        bind = next(n for n, line in enumerate(lines, 1) if 'Server::bind("127.0.0.1:0", limits).expect("bind")' in line)
        setup_at = f"{SERVER_TEST}:{bind}:{lines[bind - 1].index('expect') + 1}"
        check = next(n for n, line in enumerate(lines, 1) if line.lstrip().startswith("assert_eq!("))
        assert_at = f"{SERVER_TEST}:{check}:{lines[check - 1].index('assert_eq!') + 1}"
        setup = failing(TEST, setup_at, "bind: Os { code: 1 }")
        assertion = failing(TEST, assert_at, "assertion `left == right` failed")
        self.assertEqual(kills.classify(setup, setup, PASSES)[0], "ERROR")
        self.assertEqual(kills.classify(assertion, assertion, PASSES)[0], "KILLED")


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

    def test_every_listed_verdict_is_a_test_and_its_words_in_the_source(self):
        # A renamed test or reworded verdict leaves a stale line here, which
        # would let nothing through but would no longer say what is true.
        rust = "\n".join(path.read_text() for path in (ROOT / "crates").rglob("*.rs"))
        self.assertTrue(kills.VERDICTS, "no verdict is listed, so this test checks nothing")
        for test, verdicts in kills.VERDICTS.items():
            self.assertIn(f"fn {test.rsplit('::', 1)[-1]}(", rust, f"{test} is not a test")
            for verdict in verdicts:
                self.assertIn(f'"{verdict}"', rust, f"{test}: no verdict says {verdict!r}")

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
