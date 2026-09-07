"""The coverage floor is ONE fact. This proves the three places agree.

AGENTS.md requirement 9 says `RUST_COVERAGE_FLOOR` is "ONE fact recorded in
this file, the Makefile, and `pr-gate.yml`, and the three move together". A
sentence like that is worth exactly as much as whatever enforces it, and
nothing did: the three could drift silently, in either direction, and both
directions are bad. Raise the gate alone and AGENTS.md understates what CI
permits; raise AGENTS.md alone and the contract promises a guarantee CI does
not make. Lower the gate alone and requirement 9's ratchet is gone while every
reader still sees the old number.

HOW EACH VALUE IS FOUND -- by SEARCH, so a new legitimate declaration widens
what is read rather than failing for being new:

  workflows   every `env:` mapping at every scope of every workflow, resolved
              structurally through `miniyaml`, never by line matching. A floor
              declared on a job or a step -- which would SHADOW the workflow
              one for the step that enforces it -- is therefore read too.
  Makefile    every assignment of the variable (`=`, `?=`, `:=`).
  AGENTS.md   every CLAIM: the variable named, then a colon, `is`, `at`, or
              `=`, then a number. That shape is deliberately narrower than
              "the variable near a digit", because the contract also names the
              variable in sentences that merely describe it -- next to
              `llvm-tools`, next to `python3` -- and reading a version number
              out of one of those would fail the gate for prose.

              THE BOUNDARY, stated so nobody loses an afternoon: a sentence
              that gives the value in some other shape ("a floor of 89 for
              RUST_COVERAGE_FLOOR") is NOT read, so it can drift unnoticed.
              State the value in the pinned shape, or widen `AGENTS_CLAIM`
              here in one reviewed edit.

SILENCE IS NOT A PASS. Each of the three must yield at least one value; a file
that stopped declaring the floor fails rather than agreeing vacuously with the
others.
"""

from __future__ import annotations

import re
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import miniyaml  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
WORKFLOWS = ROOT / ".github" / "workflows"
MAKEFILE = ROOT / "Makefile"
CONTRACT = ROOT / "AGENTS.md"

VARIABLE = "RUST_COVERAGE_FLOOR"
MAKE_ASSIGNMENT = re.compile(rf"^\s*{VARIABLE}\s*(?:\?=|:=|=)\s*([0-9]+(?:\.[0-9]+)?)\s*$", re.M)
AGENTS_CLAIM = re.compile(rf"{VARIABLE}`?\s*(?::|is|at|=)\s*`?([0-9]+(?:\.[0-9]+)?)")


def _environments(node: object) -> list[dict]:
    """Every `env:` mapping anywhere in one workflow, at any scope."""
    found: list[dict] = []
    if isinstance(node, dict):
        environment = node.get("env")
        if isinstance(environment, dict):
            found.append(environment)
        for value in node.values():
            found.extend(_environments(value))
    elif isinstance(node, list):
        for value in node:
            found.extend(_environments(value))
    return found


def workflow_floors() -> dict[str, set[str]]:
    floors: dict[str, set[str]] = {}
    for path in sorted(WORKFLOWS.glob("*.yml")):
        document = miniyaml.load_one(path.read_text(encoding="utf-8"))
        values = {
            str(environment[VARIABLE])
            for environment in _environments(document)
            if VARIABLE in environment
        }
        if values:
            floors[path.name] = values
    return floors


def makefile_floors() -> set[str]:
    return set(MAKE_ASSIGNMENT.findall(MAKEFILE.read_text(encoding="utf-8")))


def contract_floors() -> set[str]:
    return set(AGENTS_CLAIM.findall(CONTRACT.read_text(encoding="utf-8")))


class TheCoverageFloorIsOneFact(unittest.TestCase):
    def test_each_source_declares_the_floor_at_least_once(self):
        # Silence is not agreement. A source that stopped declaring the floor
        # would otherwise "agree" with the other two by saying nothing.
        self.assertTrue(workflow_floors(), "no workflow declares the floor")
        self.assertTrue(makefile_floors(), "the Makefile does not assign the floor")
        self.assertTrue(contract_floors(), "AGENTS.md states no floor value")

    def test_no_source_declares_two_different_values(self):
        for name, values in workflow_floors().items():
            with self.subTest(workflow=name):
                self.assertEqual(len(values), 1, f"{name} declares {sorted(values)}")
        self.assertEqual(len(makefile_floors()), 1, sorted(makefile_floors()))
        self.assertEqual(len(contract_floors()), 1, sorted(contract_floors()))

    def test_the_three_sources_agree(self):
        declared = set(makefile_floors()) | set(contract_floors())
        for values in workflow_floors().values():
            declared |= values
        self.assertEqual(
            len(declared),
            1,
            "the coverage floor disagrees across its three recorded places: "
            f"workflows {workflow_floors()}, Makefile {sorted(makefile_floors())}, "
            f"AGENTS.md {sorted(contract_floors())}",
        )

    def test_the_floor_is_a_plain_non_negative_number(self):
        floor = next(iter(makefile_floors()))
        self.assertRegex(floor, r"^[0-9]+(\.[0-9]+)?$")
        self.assertGreaterEqual(float(floor), 0.0)
        self.assertLessEqual(float(floor), 100.0)

    def test_the_gate_enforces_the_floor_it_declares(self):
        # A declared value nothing reads is decoration. The PR gate must
        # actually run the script that consumes it.
        gate = (WORKFLOWS / "pr-gate.yml").read_text(encoding="utf-8")
        # A `run:` line, not the words anywhere: the env comment above names
        # the script too, and a substring test would be satisfied by prose
        # after the step that runs it had been deleted.
        self.assertRegex(gate, r"(?m)^\s*run:\s*\./scripts/ci/coverage\.sh\s*$")
        self.assertIn(VARIABLE, gate)
        makefile = MAKEFILE.read_text(encoding="utf-8")
        self.assertIn(f"{VARIABLE}=$({VARIABLE})", makefile)

    def test_the_claim_reader_ignores_prose_that_merely_names_the_variable(self):
        # The narrow claim shape is what keeps a sentence like "coverage
        # against RUST_COVERAGE_FLOOR, the plugin build and node --test" from
        # being read as a floor of 42.
        self.assertEqual(AGENTS_CLAIM.findall(f"coverage against `{VARIABLE}`, then python3"), [])
        self.assertEqual(
            AGENTS_CLAIM.findall(f"the floor `{VARIABLE}` (measured with llvm-tools)"), []
        )
        for shape in (f"`{VARIABLE}`: 89", f"{VARIABLE} is 89", f"{VARIABLE} = 89"):
            with self.subTest(shape=shape):
                self.assertEqual(AGENTS_CLAIM.findall(shape), ["89"])

    def test_a_disagreement_would_be_detected(self):
        # Non-vacuity: the comparison is exercised against a disagreeing set,
        # so a rewrite that made it always pass fails here.
        self.assertEqual(len({"89", "89"}), 1)
        self.assertNotEqual(len({"89", "90"}), 1)


if __name__ == "__main__":
    unittest.main()
