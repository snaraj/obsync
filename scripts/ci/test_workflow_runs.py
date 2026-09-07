"""Hostile tests for the helper that says what a workflow step RUNS.

The helper exists because `grep` said yes to a step that ran nothing, so the
tests that matter here are the ones where the TEXT of a command is present and
the command is not: a comment, a neutralized `run:` value, a commented line
inside a block scalar. Each of those must produce no segment that starts with
the command, while the shapes this repository's workflows really use --
one-line runs, literal blocks, `&&` chains, assignment prefixes -- must all
resolve.
"""

from __future__ import annotations

import io
import sys
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import workflow_runs  # noqa: E402

WORKFLOW = Path(__file__).resolve().parents[2] / ".github" / "workflows" / "pr-gate.yml"

STEPS = """\
name: probe
on:
  push:
    branches: [main]
permissions: {}
jobs:
  one:
    runs-on: ubuntu-24.04
    permissions:
      contents: read
    steps:
      - name: A step that runs nothing
        uses: actions/checkout@0000000000000000000000000000000000000000 # v7.0.1
      - name: One line
        run: cargo test --workspace
      - name: A block
        run: |
          set -euo pipefail
          # npm run build
          cd plugin && FOO=1 npm ci --ignore-scripts
          printf '# not a comment %s\\n' "${VALUE}"
          curl -sSf https://example.org/x#anchor
          true # disabled; npm run build
      - name: Neutralized
        run: true # scripts/ci/image-smoke.sh "obsync:1"
      - name: Continued
        run: |
          helm template smoke chart \\
            --kube-version v1.36.0 >/dev/null
"""


class ResolvesWhatTheStepsRun(unittest.TestCase):
    def segments(self) -> list[str]:
        return [
            segment
            for run in workflow_runs.run_values(STEPS)
            for segment in workflow_runs.segments(run)
        ]

    def test_a_step_that_runs_no_string_contributes_nothing(self):
        # Five steps, three commands. The `uses:` step is not a command, and
        # neither is `run: true # …`: the reader strips the comment and
        # resolves the bare `true` as a BOOLEAN, which is not a shell command
        # and must not be read as one.
        self.assertEqual(len(workflow_runs.run_values(STEPS)), 3)

    def test_a_single_line_run_is_one_segment(self):
        self.assertIn("cargo test --workspace", self.segments())

    def test_a_block_scalar_is_read_line_by_line(self):
        self.assertIn("set -euo pipefail", self.segments())

    def test_an_operator_splits_and_an_assignment_is_not_the_command(self):
        segments = self.segments()
        self.assertIn("cd plugin", segments)
        self.assertIn("npm ci --ignore-scripts", segments)

    def test_a_backslash_continuation_is_one_segment(self):
        self.assertIn(
            "helm template smoke chart --kube-version v1.36.0 >/dev/null",
            self.segments(),
        )

    def test_a_commented_command_produces_no_segment(self):
        # The whole point, across the two modules: the block NAMES
        # `npm run build` twice and runs it neither time. The second one is
        # the hostile shape -- `true # disabled; npm run build` -- where the
        # comment carries a shell operator, so a reader that split into
        # segments BEFORE cutting the comment would hand the caller
        # `npm run build` as a command the step runs.
        self.assertIn("# npm run build", STEPS)
        self.assertIn("true # disabled; npm run build", STEPS)
        self.assertEqual(
            [segment for segment in self.segments() if segment.startswith("npm run")],
            [],
        )

    def test_a_trailing_comment_is_not_part_of_the_command(self):
        # The reader keeps a block scalar RAW, so a comment after a command on
        # one of its lines survives to here and is cut here. The printed list
        # is a list of commands, not of text that contains them.
        self.assertIn("true", self.segments())

    def test_a_hash_inside_a_word_is_not_a_comment(self):
        # `…/x#anchor` is one word. Cutting at every `#` would silently
        # shorten a real command into a different one.
        self.assertIn("curl -sSf https://example.org/x#anchor", self.segments())

    def test_a_neutralized_run_value_produces_no_command(self):
        # `run: true # scripts/ci/image-smoke.sh "obsync:1"` is the exact shape
        # an adversarial review used to switch the image smoke off with every
        # pin still green.
        self.assertIn('run: true # scripts/ci/image-smoke.sh "obsync:1"', STEPS)
        self.assertEqual(
            [
                segment
                for segment in self.segments()
                if segment.startswith("scripts/ci/image-smoke.sh")
            ],
            [],
        )

    def test_a_quoted_hash_is_not_a_comment(self):
        # A `#` inside quotes belongs to the command, not to a comment, or a
        # `printf '# …'` would silently truncate the segment after it.
        self.assertIn(
            """printf '# not a comment %s\\n' "${VALUE}\"""",
            self.segments(),
        )


class RefusesWhatItCannotRead(unittest.TestCase):
    def test_a_document_with_no_jobs_is_refused(self):
        with self.assertRaises(ValueError):
            workflow_runs.run_values("name: probe\npermissions: {}\n")

    def test_a_construct_the_reader_refuses_is_not_silently_empty(self):
        # `miniyaml` raises on an anchor; the helper must let that escape as a
        # refusal rather than report a workflow that runs nothing.
        with self.assertRaises(ValueError):
            workflow_runs.run_values("jobs: &alias\n  one: {}\n")

    def test_the_command_line_refuses_an_unreadable_workflow(self):
        errors = io.StringIO()
        with redirect_stderr(errors):
            status = workflow_runs.main(["workflow_runs.py", str(WORKFLOW.parent)])
        self.assertEqual(status, 1)
        self.assertIn("workflow_runs:", errors.getvalue())


class TheRealWorkflowIsRead(unittest.TestCase):
    """Non-vacuity: the helper reads the file the invariant judges."""

    def test_the_pr_gate_runs_the_battery_this_repository_claims(self):
        printed = io.StringIO()
        with redirect_stdout(printed):
            status = workflow_runs.main(["workflow_runs.py", str(WORKFLOW)])
        self.assertEqual(status, 0)
        segments = printed.getvalue().splitlines()
        for command in (
            "cargo test --workspace",
            "npm run build",
            "scripts/ci/image-smoke.sh",
        ):
            self.assertTrue(
                any(segment.startswith(command) for segment in segments), command
            )


if __name__ == "__main__":
    unittest.main()
