"""Required E2EE command execution: a narrow, fail-closed shell contract.

The generic command inventory is not a shell interpreter. This security gate
has a deliberately small recipe; reject unsupported shell/control constructs
instead of claiming they propagate failure. Behavioral tests execute the
actual workflow body with a failing test command as a separate control.
"""
from pathlib import Path
import re
import sys

import miniyaml

COMMANDS = ["cargo build --locked -p obsyncd", "node scripts/ci/e2ee.mjs"]
STEP = "Verify real plugin/server encryption boundaries"


def validate(workflow, makefile):
    document = miniyaml.load_one(workflow)
    job = document["jobs"]["application"]
    if "if" in job or job.get("continue-on-error", False) is not False:
        raise ValueError("E2EE application job must run and propagate failure")
    candidates = [step for step in job["steps"] if step.get("name") == STEP]
    if len(candidates) != 1:
        raise ValueError("exactly one required E2EE step")
    step = candidates[0]
    if "if" in step or step.get("continue-on-error", False) is not False:
        raise ValueError("E2EE step must run and propagate failure")
    if "working-directory" in step or step.get("shell", "bash") != "bash":
        raise ValueError("E2EE step requires the repository root and bash")
    run = step.get("run", "")
    if [line.strip() for line in run.splitlines() if line.strip()] != ["set -euo pipefail", *COMMANDS]:
        raise ValueError("E2EE step must execute both commands without suppressing failure")
    match = re.search(r"^e2ee: plugin[^\n]*\n((?:\t[^\n]*\n)+)", makefile, re.M)
    if not match or [line.strip() for line in match[1].splitlines()] != COMMANDS:
        raise ValueError("E2EE make target must execute both commands without ignoring failure")
    return run


def main():
    try:
        validate(Path(sys.argv[1]).read_text(), Path(sys.argv[2]).read_text())
    except (ValueError, KeyError, TypeError, OSError, IndexError) as error:
        print(f"e2ee-contract: REFUSE {error}", file=sys.stderr)
        return 1
    print("e2ee-contract: required commands propagate failure")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
