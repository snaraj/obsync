"""Print what a workflow's steps RUN, as shell segments, one per line.

WHY THIS EXISTS. `scripts/ci/makefile-invariants.sh` proves the Makefile and
the PR gate run one battery. It used to prove that by searching both whole
files for the TEXT of each canonical command, and an adversarial review walked
through it: `run: true # scripts/ci/image-smoke.sh "obsync-gate-full:…"` still
contains the text, still passes actionlint, and runs nothing. The image smoke
-- the one check that had just caught a deployment-blocking defect -- could be
switched off with every pin still green. Text is not execution.

So the invariant now asks this helper what each step would actually run. The
workflow is resolved by `miniyaml`, the repository's fail-closed reader, which
refuses every construct it does not fully model, so an unreadable workflow ends
as a non-zero exit and a red gate rather than an empty answer that passes.

WHAT A SEGMENT IS. One `run:` value is split into physical lines (backslash
continuations joined), each line loses its shell comment, and each line is split
on `&&`, `||`, `|` and `;`. Leading `NAME=value` assignments and the grammar
words that stand before a command without changing it (`then`, `else`, `elif`,
`do`, `{`, `(`) are dropped. What remains is a command at the head of a
segment, which is what the caller requires: `cd plugin && npm ci …` runs npm,
`FOO=1 npm ci …` runs npm, and `true # npm ci …` and `echo 'npm ci …'` do not.

A FOLDED body (`run: >-`) is captured raw by the reader and printed line by
line rather than folded into one command. That can only make a segment SHORTER
than what the shell will see, never longer, so a canonical command split across
two folded lines fails this gate instead of passing it.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import miniyaml  # noqa: E402

SEGMENT = re.compile(r"\|\||&&|[|;]")
# An assignment prefix is stripped only when its value is bare: a quoted value
# can hold anything, including a command substitution, and pretending the word
# after it is the command would let `x="echo docker build --tag …"` count as a
# build. Bare is what `RUST_COVERAGE_FLOOR=$(RUST_COVERAGE_FLOOR) ./coverage.sh`
# is, which is the case that has to work.
ASSIGNMENT = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*=[^\s'\"]*\s+")
GRAMMAR = re.compile(r"^(?:then|else|elif|do|\{|\()\s+")


def run_values(text: str) -> list[str]:
    """Every step `run:` value in a workflow, in file order."""
    document = miniyaml.load_one(text)
    jobs = document.get("jobs") if isinstance(document, dict) else None
    if not isinstance(jobs, dict):
        raise ValueError("no `jobs:` mapping to read steps from")
    found: list[str] = []
    for job in jobs.values():
        steps = job.get("steps") if isinstance(job, dict) else None
        for step in steps if isinstance(steps, list) else []:
            run = step.get("run") if isinstance(step, dict) else None
            if isinstance(run, str):
                found.append(run)
    return found


def strip_comment(line: str) -> str:
    """The line up to its first UNQUOTED `#` that starts a word."""
    quote = ""
    for index, character in enumerate(line):
        if quote:
            if character == quote:
                quote = ""
        elif character in "'\"":
            quote = character
        elif character == "#" and (index == 0 or line[index - 1].isspace()):
            return line[:index]
    return line


def segments(run: str) -> list[str]:
    """The executable shell segments of one `run:` value."""
    found: list[str] = []
    for line in _lines(run):
        for part in SEGMENT.split(strip_comment(line)):
            segment = part.strip()
            while True:
                shortened = GRAMMAR.sub("", ASSIGNMENT.sub("", segment)).strip()
                if shortened == segment:
                    break
                segment = shortened
            if segment:
                found.append(segment)
    return found


def _lines(run: str) -> list[str]:
    """Physical lines with backslash continuations joined."""
    found: list[str] = []
    pending = ""
    for raw in run.splitlines():
        stripped = raw.strip()
        if stripped.endswith("\\"):
            pending += stripped[:-1].strip() + " "
            continue
        found.append(pending + stripped)
        pending = ""
    if pending:
        found.append(pending)
    return found


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        print("usage: workflow_runs.py <workflow.yml>", file=sys.stderr)
        return 2
    try:
        runs = run_values(Path(argv[1]).read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        print(f"workflow_runs: {argv[1]}: {error}", file=sys.stderr)
        return 1
    for run in runs:
        for segment in segments(run):
            print(segment)
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
