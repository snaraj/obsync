"""Hostile tests for the commit identity, trailer, and signature gate.

The gate's whole value is that it refuses things, so this suite spends most of
its lines proving refusals rather than acceptances -- and proving that each
refusal names the SHA and the rule while never echoing the address it exists to
keep out of the public record.
"""

from __future__ import annotations

import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import commit_identity_contract as contract  # noqa: E402

OWNER = contract.SANCTIONED_EMAIL
MERGE = contract.GITHUB_MERGE_EMAIL
STRANGER = "someone@example.invalid"
BODY = "Subject line\n\nBody paragraph.\n\n- Opus5"


def commit(
    sha: str = "0" * 40,
    author: str = OWNER,
    committer: str = OWNER,
    body: str = BODY,
) -> contract.Commit:
    return contract.Commit(sha, author, committer, body)


def rules(commits: list[contract.Commit]) -> set[str]:
    return {refusal.rule for refusal in contract.refusals(commits)}


class TheCleanCaseIsAccepted(unittest.TestCase):
    def test_owner_identity_no_trailer_and_a_roster_signature(self):
        self.assertEqual(contract.refusals([commit()]), [])

    def test_every_roster_signature_is_accepted(self):
        for signature in contract.LANE_SIGNATURES:
            with self.subTest(signature=signature):
                self.assertEqual(
                    contract.refusals([commit(body=f"Subject\n\nBody.\n\n{signature}")]), []
                )


class IdentityRefusals(unittest.TestCase):
    def test_a_foreign_author_or_committer_is_refused(self):
        self.assertIn("identity", rules([commit(author=STRANGER)]))
        self.assertIn("identity", rules([commit(committer=STRANGER)]))

    def test_the_github_merge_identity_is_admitted_as_committer_only(self):
        # It names no person, and refusing it would refuse every owner web
        # merge forever. As an AUTHOR it is refused, because the author field
        # is the attribution requirement 3 is actually about.
        self.assertNotIn("identity", rules([commit(committer=MERGE)]))
        self.assertIn("identity", rules([commit(author=MERGE)]))

    def test_a_refusal_never_echoes_the_offending_address(self):
        messages = contract.report([commit(author=STRANGER)], {})
        self.assertTrue(messages)
        for message in messages:
            self.assertNotIn(STRANGER, message)
            self.assertIn("0" * 40, message)


class TrailerRefusals(unittest.TestCase):
    def test_each_forbidden_trailer_is_refused(self):
        for trailer in (
            "Co-Authored-By: Someone <x@example.invalid>",
            "Claude-Session: https://claude.ai/code/session_x",
            "Signed-off-by: Someone <x@example.invalid>",
        ):
            with self.subTest(trailer=trailer):
                body = f"Subject\n\nBody.\n\n- Opus5\n{trailer}"
                self.assertIn("trailer", rules([commit(body=body)]))

    def test_the_match_is_case_and_whitespace_tolerant(self):
        # git and GitHub both credit these shapes, so the gate refuses them.
        for spelling in ("co-authored-by:", "  Co-Authored-By  :", "CO-AUTHORED-BY:"):
            with self.subTest(spelling=spelling):
                body = f"Subject\n\nBody.\n\n- Opus5\n{spelling} Someone"
                self.assertIn("trailer", rules([commit(body=body)]))

    def test_a_trailer_word_in_prose_is_not_a_trailer(self):
        # The refusal is anchored to the start of a line, so discussing the
        # rule in a commit body does not trip it.
        body = "Subject\n\nWe never add a Co-authored-by trailer here.\n\n- Opus5"
        self.assertNotIn("trailer", rules([commit(body=body)]))


class SignatureRefusals(unittest.TestCase):
    def test_a_missing_or_foreign_signature_is_refused(self):
        for body in (
            "Subject only",
            "Subject\n\nBody.\n\n- SomeoneElse",
            "Subject\n\nBody.\n\n- Opus5\nafterword",
            "",
        ):
            with self.subTest(body=body):
                self.assertIn("signature", rules([commit(body=body)]))

    def test_trailing_blank_lines_do_not_hide_the_signature(self):
        self.assertNotIn("signature", rules([commit(body="Subject\n\n- Opus5\n\n\n")]))

    def test_a_github_merge_commit_is_exempt(self):
        # The owner composes those and cannot choose otherwise; a rule that
        # refused them would be red on every owner merge forever.
        self.assertNotIn("signature", rules([commit(committer=MERGE, body="Merge #1")]))


class AllowlistBehaviour(unittest.TestCase):
    def test_every_rule_lifts_through_one_entry(self):
        offender = commit(author=STRANGER, body="Subject\n\nCo-authored-by: x")
        found = contract.refusals([offender])
        self.assertEqual({refusal.rule for refusal in found}, {"identity", "trailer", "signature"})
        entries = {(refusal.sha, refusal.rule): "test" for refusal in found}
        self.assertEqual(contract.report([offender], entries), [])

    def test_a_malformed_allowlist_line_is_refused(self):
        for text in (
            "only | two",
            "not-a-sha | identity | reason",
            "0000000000000000000000000000000000000000 | unknown-rule | reason",
            "0000000000000000000000000000000000000000 | identity | ",
            "abc1234 | identity | abbreviated SHAs are refused",
        ):
            with self.subTest(text=text):
                with self.assertRaises(AssertionError):
                    contract.read_allowlist(text)

    def test_the_shipped_allowlist_parses_and_is_empty(self):
        self.assertEqual(contract.read_allowlist(), {})


class LogParsingFailsClosed(unittest.TestCase):
    def test_a_multi_line_body_is_one_record(self):
        record = contract.FIELD_SEPARATOR.join(
            ("a" * 40, OWNER, OWNER, "Subject\n\nTwo\nlines\n\n- Opus5")
        ) + contract.RECORD_SEPARATOR
        commits = contract.parse_log(record)
        self.assertEqual(len(commits), 1)
        self.assertIn("Two\nlines", commits[0].body)

    def test_an_unreadable_record_raises_rather_than_passing(self):
        for text in (
            "not-separated-at-all" + contract.RECORD_SEPARATOR,
            contract.FIELD_SEPARATOR.join(("short", OWNER, OWNER, BODY))
            + contract.RECORD_SEPARATOR,
        ):
            with self.subTest(text=text[:20]):
                with self.assertRaises(AssertionError):
                    contract.parse_log(text)


class AgainstARealRepository(unittest.TestCase):
    """End to end over git, because the log format is half the gate."""

    def test_a_real_range_is_walked_and_refused_on_its_merits(self):
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            run = lambda *args, **kwargs: subprocess.run(  # noqa: E731
                ["git", "-C", str(root), *args], check=True, capture_output=True, **kwargs
            )
            run("init", "-q", "-b", "main")
            (root / "a.txt").write_text("one\n", encoding="utf-8")
            run("add", ".")
            environment = {
                "GIT_AUTHOR_NAME": "Samuel Naranjo",
                "GIT_AUTHOR_EMAIL": OWNER,
                "GIT_COMMITTER_NAME": "Samuel Naranjo",
                "GIT_COMMITTER_EMAIL": OWNER,
                "GIT_AUTHOR_DATE": "2026-09-07T00:00:00+00:00",
                "GIT_COMMITTER_DATE": "2026-09-07T00:00:00+00:00",
                "PATH": "/usr/bin:/bin:/usr/local/bin",
                "HOME": str(root),
            }
            run("commit", "-q", "-m", BODY, env=environment)
            base = run("rev-parse", "HEAD", text=True).stdout.strip()
            (root / "a.txt").write_text("two\n", encoding="utf-8")
            run("add", ".")
            run(
                "commit", "-q", "-m", "Subject\n\nBody.\n\nCo-authored-by: X <x@example.invalid>",
                env={**environment, "GIT_AUTHOR_EMAIL": STRANGER},
            )
            head = run("rev-parse", "HEAD", text=True).stdout.strip()

            self.assertEqual(contract.report(contract.read_commits(root, base, base), {}), [])
            messages = contract.report(contract.read_commits(root, base, head), {})
            self.assertEqual(len(messages), 3)
            self.assertTrue(all(head in message for message in messages))
            self.assertFalse(any(STRANGER in message for message in messages))

    def test_an_unresolvable_range_raises_rather_than_reporting_clean(self):
        with tempfile.TemporaryDirectory() as raw:
            with self.assertRaises(AssertionError):
                contract.read_commits(Path(raw), "nope", "alsonope")


if __name__ == "__main__":
    unittest.main()
