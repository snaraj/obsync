"""One verdict for every cargo mutation runner in this directory (review of 1cc99e32).

A test run that fails is not, by itself, a killed mutant: a sandbox with no
loopback fails every server test at its listener, and the runners used to
count that as a kill. So a mutant is KILLED only when, in this environment:

- the selector passes on the unmutated source and runs at least one test,
  checked before any mutation and again when the mutant fails, on a copy of
  the test binary built once from the starting bytes;
- the mutant compiles, at least one selected test panics, and a second run of
  the same mutant fails in the same tests;

and the evidence (each failing test, where it panicked, and the first line of
its message) is printed. A failure the unmutated binary shares, or one that
does not repeat, is ERROR, never a kill, and a runner that meets one cannot
report success.
"""

import json
import os
import re
import shutil
import subprocess
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
# `thread 'name' (id) panicked at file:line:col:` then the message; older
# toolchains omit the id. A test's helper threads panic as '<unnamed>'.
PANIC = re.compile(r"^thread '([^']+)'(?: \(\d+\))? panicked at ([^\n]+):\n([^\n]*)", re.M)
FAILING = re.compile(r"^---- (\S+) stdout ----$", re.M)
PASSED = re.compile(r"^test result: ok\. (\d+) passed", re.M)


def baseline_failure(baseline):
    """Why the unmutated run (returncode, output) cannot judge, or None."""
    code, output = baseline
    passed = PASSED.search(output)
    if code == 0 and passed and int(passed.group(1)) > 0:
        return None
    shared = PANIC.findall(output)
    return f"{shared[-1][0]} at {shared[-1][1]}: {shared[-1][2]}" if shared else "it runs no test"


def classify(first, again, baseline):
    """The verdict and its evidence from the mutant's run `first`, its repeat
    `again` (None when there was none) and the unmutated `baseline`; each is
    (returncode, output). Pure, so a test can hold it to every case."""
    code, output = first
    if "could not compile" in output:
        return "NOT A KILL", "the mutant did not compile"
    if code == 0:
        return "NOT A KILL", "the selected tests passed"
    failing = set(FAILING.findall(output))
    panics = [panic for panic in PANIC.findall(output) if panic[0] in failing]
    if not panics:
        return "ERROR", "no selected test panicked: a harness failure, not an assertion"
    why = baseline_failure(baseline)
    if why is not None:
        return "ERROR", f"the unmutated binary fails here too ({why}): the environment's failure, not the mutant's"
    if again is None or again[0] == 0 or set(FAILING.findall(again[1])) != failing:
        return "ERROR", "the failure did not repeat in the same tests"
    return "KILLED", "\n".join(f"  {test} at {at}: {message}" for test, at, message in panics)


class Judge:
    """Builds the unmutated test binary of each crate once, refuses to start
    unless every selector passes on it, then judges each mutant (`test`)."""

    def __init__(self, selections):
        self.scratch = tempfile.TemporaryDirectory(prefix="kills-")
        self.binaries = {}
        try:
            for crate in sorted({crate for crate, _ in selections}):
                self.binaries[crate] = self._build(crate)
            refused = []
            for crate, selector in sorted(set(selections)):
                why = baseline_failure(self.baseline(crate, selector))
                if why is not None:
                    refused.append(f"{crate} {selector}: {why}")
            if refused:
                raise SystemExit("ERROR: no mutant can be judged here, because the unmutated "
                                 "baseline does not pass:\n" + "\n".join(refused))
        except BaseException:
            self.scratch.cleanup()
            raise

    def _build(self, crate):
        built = subprocess.run(
            ["cargo", "test", "-p", crate, "--lib", "--no-run", "--message-format=json"],
            cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, check=True)
        for line in built.stdout.splitlines():
            message = json.loads(line) if line.startswith("{") else {}
            if (message.get("reason") == "compiler-artifact" and message.get("executable")
                    and message["profile"]["test"] and "lib" in message["target"]["kind"]):
                copy = Path(self.scratch.name) / crate
                shutil.copy2(message["executable"], copy)
                return copy, Path(message["manifest_path"]).parent
        raise SystemExit(f"ERROR: cargo built no library test binary for {crate}")

    def baseline(self, crate, selector):
        binary, home = self.binaries[crate]
        ran = subprocess.run([str(binary), selector], cwd=home, stdout=subprocess.PIPE,
                             stderr=subprocess.STDOUT, text=True, timeout=600, check=False,
                             env={**os.environ, "CARGO_MANIFEST_DIR": str(home)})
        return ran.returncode, ran.stdout

    def test(self, selector, crate="obsyncd"):
        """Judge the mutation now in the tree: call it before restoring it."""
        command = ["cargo", "test", "-p", crate, "--lib", selector]

        def run():
            try:
                done = subprocess.run(command, cwd=ROOT, stdout=subprocess.PIPE,
                                      stderr=subprocess.STDOUT, text=True, timeout=600, check=False)
                return done.returncode, done.stdout
            except subprocess.TimeoutExpired as expired:
                partial = expired.stdout or b""
                if isinstance(partial, bytes):
                    partial = partial.decode(errors="replace")
                return 0, partial + "\n(timed out: not a kill)"

        first = run()
        if first[0] == 0 or "could not compile" in first[1] or not FAILING.search(first[1]):
            return classify(first, None, None)
        return classify(first, run(), self.baseline(crate, selector))

    def close(self):
        self.scratch.cleanup()
