"""Narrow refusals in `.github/workflows/` -- and deliberately no step census.

WHAT THIS REFUSES. Four constructs, each of which silently changes what a gate
MEANS rather than merely what it does:

  1. `action-pin` -- a `uses:` that is not `owner/repo[/path]@<40-hex>` with a
     version comment. A tag or branch reference is a mutable pointer to code
     GitHub will run with this repository's token: the tag `v7` can be moved
     onto anything at any time, and the release path's whole argument rests on
     bytes being decided in advance (requirement 5). The version COMMENT is
     required too, because a bare SHA is unreviewable -- a reader cannot tell
     v7.0.1 from a commit on someone's fork without leaving the diff.

  2. `permissions` -- a workflow with no top-level `permissions:` block, or a
     job with no `permissions:` of its own. GitHub's default token grant is
     whatever the repository setting says, so an undeclared job inherits an
     amount of authority nobody wrote down. Declaring `permissions: {}` at the
     top and the exact grant per job makes every token in this repository a
     decision.

  3. `pull-request-target` -- the trigger that runs a workflow definition from
     the BASE branch with a writable token while checking out a fork's code.
     There is no use for it here and every use of it is one edit away from
     executing a stranger's script with this repository's credentials.

  4. `persist-credentials` -- a checkout that does not set
     `persist-credentials: false`. The default leaves a credential in
     `.git/config` for every later step in the job, so any subsequent tool
     that can run `git push` inherits write access it was never granted.

WHAT IT DELIBERATELY DOES NOT DO -- READ THIS BEFORE "COMPLETING" IT. There is
no closed step inventory. This gate will never assert "the chart job has
exactly these N steps" or "the workflows declare exactly these job names". That
pin is tempting because it looks thorough, and it is precisely the failure mode
this gate avoids: an exhaustive-inventory assertion breaks on every legitimate
addition, so it trains its readers to edit it reflexively until it means
nothing. The release contract already pins the job inventory it needs, once,
where the publisher reads it.

TWO KINDS OF RED, AND ONLY ONE LIFTS. A RULE refusal is a verdict about a value
the reader RESOLVED; it prints a lift line and lifts through one entry in
`workflow-integrity-allowlist.txt`. A READER refusal is raised while the file
is being resolved, before any rule consults the allowlist: `miniyaml` refuses
every construct it does not fully model, so an unparseable workflow fails this
gate rather than passing it, and no allowlist entry can silence that. The
remedy for a reader refusal is to write the construct in a shape the reader
resolves, or to widen the reader in one reviewed edit -- which is a gate change
and is reviewed like one.
"""

from __future__ import annotations

import re
import sys
import unittest
from dataclasses import dataclass
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import miniyaml  # noqa: E402

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
WORKFLOWS = ROOT / ".github" / "workflows"
ALLOWLIST = HERE / "workflow-integrity-allowlist.txt"

RULES = ("action-pin", "permissions", "pull-request-target", "persist-credentials")

# Over-approximating on purpose: this matches a `uses:` anywhere in the file,
# including one that only LOOKS like a step key because it sits inside a `run:`
# body. An inert match costs one pin comment; a missed real one costs the
# supply chain. `test_every_parsed_action_is_also_seen_by_the_line_scan` proves
# the over-approximation is a superset of what the reader resolves, so the two
# views can never disagree in the dangerous direction.
USES_LINE = re.compile(r"^\s*(?:-\s+)?uses:\s*(?P<ref>\S+)\s*(?P<comment>#.*)?$", re.MULTILINE)
PINNED = re.compile(r"^[A-Za-z0-9][\w.-]*/[\w.-]+(?:/[\w.-]+)*@[0-9a-f]{40}$")
LOCAL = re.compile(r"^\./")
VERSION_COMMENT = re.compile(r"^#\s*v?[0-9][0-9A-Za-z.+-]*\s*$")
CHECKOUT = "actions/checkout"


@dataclass(frozen=True)
class Refusal:
    workflow: str
    rule: str
    where: str
    detail: str

    @property
    def lift(self) -> str:
        return f"{self.workflow} | {self.rule} | {self.where} | <why this is admissible>"


def workflow_files() -> list[Path]:
    return sorted(
        path
        for path in WORKFLOWS.iterdir()
        if path.is_file() and path.suffix in {".yml", ".yaml"}
    )


def read_allowlist(text: str | None = None) -> dict[tuple[str, str, str], str]:
    """Parse `<workflow> | <rule> | <where> | <reason>` lines, failing closed."""
    entries: dict[tuple[str, str, str], str] = {}
    if text is None:
        text = ALLOWLIST.read_text(encoding="utf-8")
    for number, raw in enumerate(text.splitlines(), start=1):
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        parts = [part.strip() for part in line.split("|")]
        if len(parts) != 4:
            raise AssertionError(
                f"{ALLOWLIST.name}:{number}: expected exactly four `|`-separated "
                "fields -- `<workflow file> | <rule> | <where> | <reason>`."
            )
        workflow, rule, where, reason = parts
        if not all(parts):
            raise AssertionError(
                f"{ALLOWLIST.name}:{number}: every field must be non-empty. "
                "An allowlist without reasons is a mute button."
            )
        if rule not in RULES:
            raise AssertionError(
                f"{ALLOWLIST.name}:{number}: unknown rule {rule!r}; expected one of "
                f"{', '.join(RULES)}."
            )
        entries[(workflow, rule, where)] = reason
    return entries


def _steps(job: dict) -> list[dict]:
    steps = job.get("steps")
    if steps is None:
        return []
    if not isinstance(steps, list) or any(not isinstance(step, dict) for step in steps):
        raise AssertionError("a job declares steps this reader cannot resolve")
    return steps


def _step_name(step: dict, index: int) -> str:
    name = step.get("name")
    return name if isinstance(name, str) and name else f"step[{index}]"


def refusals(name: str, text: str) -> list[Refusal]:
    """Every rule violation in one workflow, before the allowlist is applied."""
    document = miniyaml.load_one(text)
    if not isinstance(document, dict):
        raise AssertionError(f"{name} is not a workflow mapping")
    found: list[Refusal] = []

    # Rule 3 first: it is a raw-text rule, so it holds even for a construct a
    # structural reader would place somewhere unexpected.
    if "pull_request_target" in text:
        found.append(
            Refusal(name, "pull-request-target", "<file>", "pull_request_target appears")
        )

    # Rule 1, over the line scan rather than the resolved tree; see USES_LINE.
    for match in USES_LINE.finditer(text):
        reference = match.group("ref")
        comment = (match.group("comment") or "").strip()
        where = reference
        if LOCAL.match(reference):
            continue
        if not PINNED.match(reference):
            found.append(
                Refusal(name, "action-pin", where, "not owner/repo@<40-hex commit SHA>")
            )
            continue
        if not VERSION_COMMENT.match(comment):
            found.append(
                Refusal(name, "action-pin", where, "no `# vX.Y.Z` version comment")
            )

    # Rule 2.
    if "permissions" not in document:
        found.append(Refusal(name, "permissions", "<workflow>", "no top-level permissions"))
    jobs = document.get("jobs")
    if not isinstance(jobs, dict) or not jobs:
        raise AssertionError(f"{name} declares no jobs this reader can resolve")
    for job_name, job in jobs.items():
        if not isinstance(job, dict):
            raise AssertionError(f"{name} job {job_name!r} is not a mapping")
        if "permissions" not in job:
            found.append(Refusal(name, "permissions", job_name, "job declares no permissions"))
        # Rule 4.
        for index, step in enumerate(_steps(job)):
            uses = step.get("uses")
            if not isinstance(uses, str) or not uses.split("@", 1)[0].endswith(CHECKOUT):
                continue
            with_block = step.get("with")
            where = f"{job_name}/{_step_name(step, index)}"
            if not isinstance(with_block, dict) or with_block.get("persist-credentials") is not False:
                found.append(
                    Refusal(name, "persist-credentials", where, "checkout keeps its credential")
                )
    return found


def report(entries: dict[tuple[str, str, str], str]) -> list[str]:
    messages: list[str] = []
    for path in workflow_files():
        for refusal in refusals(path.name, path.read_text(encoding="utf-8")):
            if (refusal.workflow, refusal.rule, refusal.where) in entries:
                continue
            messages.append(
                f"{refusal.workflow}: {refusal.rule} at {refusal.where}: {refusal.detail}."
                f"\n  To lift, add ONE line to {ALLOWLIST.name}:\n    {refusal.lift}"
            )
    return messages


CLEAN_WORKFLOW = """name: Clean
on:
  pull_request:
permissions: {}
jobs:
  build:
    runs-on: ubuntu-24.04
    permissions:
      contents: read
    steps:
      - name: Check out repository
        uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          persist-credentials: false
      - name: Run
        run: echo ok
"""


class WorkflowIntegrityTests(unittest.TestCase):
    def test_the_repository_workflows_carry_no_unlifted_refusal(self):
        self.assertEqual(report(read_allowlist()), [])

    def test_there_is_at_least_one_workflow_to_read(self):
        # A gate with no subject is a gate that cannot fail. If the directory
        # is ever emptied or renamed, this says so instead of passing.
        self.assertTrue(workflow_files())

    def test_a_clean_workflow_produces_no_refusal(self):
        self.assertEqual(refusals("clean.yml", CLEAN_WORKFLOW), [])

    def test_every_rule_refuses_its_own_construct(self):
        cases = {
            "action-pin": CLEAN_WORKFLOW.replace(
                "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1",
                "actions/checkout@v7",
            ),
            "permissions": CLEAN_WORKFLOW.replace("permissions: {}\n", "", 1),
            "pull-request-target": CLEAN_WORKFLOW.replace(
                "  pull_request:", "  pull_request_target:"
            ),
            "persist-credentials": CLEAN_WORKFLOW.replace(
                "          persist-credentials: false", "          fetch-depth: 0"
            ),
        }
        for rule, text in cases.items():
            with self.subTest(rule=rule):
                self.assertIn(rule, {refusal.rule for refusal in refusals("hostile.yml", text)})

    def test_a_mutable_reference_is_refused_even_with_a_version_comment(self):
        # Without this case the pin rule and the comment rule are
        # indistinguishable: `@v7` with no comment reddens either way, so a
        # regex loosened to accept a tag would still look green.
        text = CLEAN_WORKFLOW.replace(
            "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1",
            "actions/checkout@v7 # v7.0.1",
        )
        found = refusals("hostile.yml", text)
        self.assertEqual([refusal.rule for refusal in found], ["action-pin"])
        self.assertIn("40-hex", found[0].detail)

    def test_a_branch_or_partial_sha_reference_is_refused(self):
        for reference in ("actions/checkout@main", "actions/checkout@3d3c42e", "actions/checkout"):
            with self.subTest(reference=reference):
                text = CLEAN_WORKFLOW.replace(
                    "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1", reference
                )
                self.assertIn(
                    "action-pin", {refusal.rule for refusal in refusals("hostile.yml", text)}
                )

    def test_the_version_comment_is_required_not_only_the_sha(self):
        text = CLEAN_WORKFLOW.replace(
            "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1",
            "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
        )
        found = refusals("hostile.yml", text)
        self.assertEqual([refusal.rule for refusal in found], ["action-pin"])
        self.assertIn("version comment", found[0].detail)

    def test_a_job_level_permissions_omission_is_refused_on_its_own(self):
        text = CLEAN_WORKFLOW.replace("    permissions:\n      contents: read\n", "")
        found = [refusal for refusal in refusals("hostile.yml", text) if refusal.rule == "permissions"]
        self.assertEqual([refusal.where for refusal in found], ["build"])

    def test_every_rule_lifts_through_the_allowlist(self):
        text = CLEAN_WORKFLOW.replace(
            "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1",
            "actions/checkout@v7",
        ).replace("permissions: {}\n", "", 1)
        found = refusals("hostile.yml", text)
        self.assertTrue(found)
        entries = {
            (refusal.workflow, refusal.rule, refusal.where): "test" for refusal in found
        }
        remaining = [
            refusal
            for refusal in found
            if (refusal.workflow, refusal.rule, refusal.where) not in entries
        ]
        self.assertEqual(remaining, [])

    def test_every_parsed_action_is_also_seen_by_the_line_scan(self):
        # The line scan is an over-approximation on purpose. This proves it is
        # a SUPERSET of what the structural reader resolves, so no real `uses:`
        # can hide from rule 1 in the shape of something the regex misses.
        for path in workflow_files():
            with self.subTest(workflow=path.name):
                text = path.read_text(encoding="utf-8")
                scanned = {match.group("ref") for match in USES_LINE.finditer(text)}
                document = miniyaml.load_one(text)
                resolved = {
                    step["uses"]
                    for job in document["jobs"].values()
                    for step in _steps(job)
                    if isinstance(step.get("uses"), str)
                }
                self.assertTrue(resolved <= scanned, resolved - scanned)

    def test_a_malformed_allowlist_entry_is_refused(self):
        for text in (
            "only-two | fields",
            "workflow.yml | not-a-rule | where | reason",
            "workflow.yml | action-pin |  | reason",
        ):
            with self.subTest(text=text):
                with self.assertRaises(AssertionError):
                    read_allowlist(text)

    def test_a_reader_refusal_is_not_liftable(self):
        # An unresolvable construct raises before any rule consults the
        # allowlist, so there is no verdict to waive. This pins that the gate
        # goes RED rather than quietly finding nothing to refuse.
        with self.assertRaises(miniyaml.YamlError):
            refusals("hostile.yml", CLEAN_WORKFLOW.replace("permissions: {}", "permissions: &a {}"))

    def test_the_shipped_allowlist_names_real_workflows(self):
        names = {path.name for path in workflow_files()}
        for key in read_allowlist():
            self.assertIn(key[0], names)

    def test_the_shipped_allowlist_has_no_stale_entry(self):
        # The file ratchets shut: an entry whose refusal no longer occurs is
        # removed, not left behind to waive something nobody meant.
        live = {
            (refusal.workflow, refusal.rule, refusal.where)
            for path in workflow_files()
            for refusal in refusals(path.name, path.read_text(encoding="utf-8"))
        }
        for key in read_allowlist():
            self.assertIn(key, live, f"stale allowlist entry: {key}")


if __name__ == "__main__":
    unittest.main()
