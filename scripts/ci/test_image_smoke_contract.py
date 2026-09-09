"""`image-smoke.sh`'s DENY account is a control, so it gets a control.

WHY. The smoke's value is that it RUNS the shipped image; its value on a bad
day is the account `deny` prints before it exits. Issue #19 is the day that
account was not enough. The startup refusal said

    event=posture_failed decision=exit refusal=io_error

and nothing more, because the Docker Desktop VM's disk was 100 % full. A mount
owned by somebody else and a mount that is not there print that identical
line, so the cause cost a diagnostic detour through a probe container. The
server now names the `io::ErrorKind` behind the refusal, and `deny` now names
the number behind `StorageFull`: `df` of both volumes read from inside them,
and the daemon's own `docker system df`.

WHAT IS PINNED, and why each is the property rather than the text:

  1. both volumes are read, from inside, through the pinned throwaway. The
     obsync image is distroless and has no `df`, so the only way to see a
     volume's free space is to mount it into an image that has one. That image
     must be the compose path's digest-pinned terminator and never a tag:
     `deny` runs on this script's worst day, and resolving a mutable reference
     then is both a new failure mode and an unpinned image in a security gate.

  2. the daemon's own account is printed. The volumes live in the daemon's
     filesystem, and on Docker Desktop that filesystem is a VM disk which the
     per-volume `df` describes but does not explain.

  3. every command `deny` runs is best-effort. `deny` exists to explain a
     refusal that already happened; a command in it that can fail, under
     `set -e`, replaces that refusal with its own and the reason is lost.

  4. `deny` still exits 1. An account that changed the exit code would turn a
     refusal into a pass.

  5. the throwaway is resolved before anything that can call `deny`. The
     script runs under `set -u`, so a `deny` reading an unset variable would
     abort the shell instead of printing -- and only on the days it matters.

TWO READERS, BECAUSE ONE WAS NOT ENOUGH. The first version of this file read
`deny`'s body for command-SHAPED segments and called that executable
structure. Round 1 of #21 walked through it with two lines of ordinary shell:
wrapping the unchanged volume read in `if false; then … fi` left every rule
green while the diagnostic no longer ran. Counting a segment is not proving it
executes. So:

  STRUCTURE (`refusals`). The container-log loop that `deny` already carried
  is pinned VERBATIM as `CONTAINER_LOOP` and lifted out of the body; after
  that, any control-flow word in what remains -- `if`, `then`, `fi`, `for`,
  `while`, `{`, `!`, and the rest -- is a refusal naming the segment, because
  this reader cannot say whether a command inside it runs. A required
  diagnostic standing behind `&&` or `||` is refused for the same reason. The
  straight-line remainder is then read as before: continuations joined,
  comments removed quote-aware, and each logical line split into segments,
  also quote-aware because `&&` and `;` stand inside the awk program that
  resolves the throwaway.

  EXECUTION (`run_deny`). `deny` is extracted with the five variables it
  reads bound to synthetic values -- the whole script is never sourced, and
  nothing here touches a container runtime -- and run under
  `bash --noprofile --norc` with a `docker` stub on PATH that records its argv
  and exits 0. The tests then assert what RAN: one `run` carrying `--user 0`,
  both mounts, the pinned throwaway and `df -h /data/blobs /data/journal`; one
  `system df`; the probe, the logs and the formatted inspect for each named
  container; both headings on stderr; and exit 1. A second stub makes the
  volume read fail, and `deny` must still reach `system df` and still exit 1,
  which is what `|| true` is for.

EVERY RULE HAS A NEGATIVE TEST. `MutatedSmokeIsRefused` re-runs both readers
over the real script with one property broken -- in memory, never on disk --
so a rule that stopped being able to fail fails here instead. Round 1's
`if false` mutant is one of them, on both readers.
"""

from __future__ import annotations

import os
import re
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SMOKE = ROOT / "scripts" / "ci" / "image-smoke.sh"
SMOKE_NAME = "scripts/ci/image-smoke.sh"

# The one image `deny` may mount the volumes into, and the two mounts.
THROWAWAY = '"${throwaway}"'
BLOBS_MOUNT = '"${blobs_volume}:/data/blobs"'
JOURNAL_MOUNT = '"${journal_volume}:/data/journal"'
# Where the throwaway comes from, and the shape it is accepted in.
THROWAWAY_SOURCE = "deploy/compose/docker-compose.yml"
THROWAWAY_DIGEST = r"^docker\.io\/library\/caddy@sha256:"
# The two headings an operator reads the numbers under.
VOLUME_SPACE_HEADING = "image-smoke: --- volume space ---"
SYSTEM_HEADING = "image-smoke: --- docker system df ---"
# The tail of the one command that reads the volumes.
DF_ARGV = ("df", "-h", "/data/blobs", "/data/journal")

# The ONE control-flow block `deny` may contain, matched verbatim. It predates
# issue #19 and prints the container's own account; the reader cannot prove
# what runs inside a loop, so it is pinned as text and lifted out rather than
# read as commands. Its `|| true` guards are part of that text.
CONTAINER_LOOP = """  for name in "${container}" "${restored}"; do
    if docker container inspect "${name}" >/dev/null 2>&1; then
      printf 'image-smoke: --- container logs (%s) ---\\n' "${name}" >&2
      docker logs "${name}" >&2 2>&1 || true
      printf 'image-smoke: --- container state (%s) ---\\n' "${name}" >&2
      docker container inspect --format \\
        'status={{.State.Status}} exit={{.State.ExitCode}} error={{.State.Error}}' \\
        "${name}" >&2 || true
    fi
  done"""
LOOP_HEADER = CONTAINER_LOOP.splitlines()[0]
LOOP_CLOSE = CONTAINER_LOOP.splitlines()[-1]

# Words that open, close or steer a block. A command standing after any of
# them is a command this reader cannot say runs.
CONTROL = frozenset(
    {
        "if", "then", "else", "elif", "fi",
        "case", "esac", "while", "until", "for", "do", "done",
        "{", "}", "(", ")", "!",
    }
)
_CONTROL_OPENERS = "{}()!"

_FUNCTION = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*\(\) \{$")

# The synthetic world the executed reader runs `deny` in. None of these names
# reaches a container runtime: the only `docker` on PATH is the stub below.
STUB_CONTAINER = "smoke-container"
STUB_RESTORED = "smoke-restored"
STUB_BLOBS = "smoke-blobs-volume"
STUB_JOURNAL = "smoke-journal-volume"
STUB_THROWAWAY = "docker.io/library/caddy@sha256:" + "0" * 64
STUB_REASON = "synthetic reason"

# One line per call, argv fields tab-separated, so a flag and its value are two
# words and never a substring of the joined text. `STUB_DF_FAIL` makes only the
# volume read fail, which is what `|| true` has to survive.
DOCKER_STUB = r"""#!/bin/sh
{
  separator=''
  for argument in "$@"; do
    printf '%s%s' "${separator}" "${argument}"
    separator='	'
  done
  printf '\n'
} >> "${STUB_LOG}"
if [ -n "${STUB_DF_FAIL:-}" ]; then
  case " $* " in
    *" df -h /data/blobs /data/journal "*) exit 1 ;;
  esac
fi
exit 0
"""


def uncomment(line: str) -> str:
    """`line` with its comment removed, quotes respected."""
    quote = ""
    for index, char in enumerate(line):
        if quote:
            if char == quote:
                quote = ""
            continue
        if char in "'\"":
            quote = char
            continue
        if char == "#" and (index == 0 or line[index - 1].isspace()):
            return line[:index]
    return line


def segments(line: str) -> list[str]:
    """One logical line's commands and the operators between them.

    Quote-aware: `&&` and `;` inside the awk program that resolves the
    throwaway separate nothing, and a reader that split on them would read one
    assignment as five commands.
    """
    found: list[str] = []
    current = ""
    quote = ""
    index = 0
    while index < len(line):
        char = line[index]
        if quote:
            current += char
            if char == quote:
                quote = ""
            index += 1
            continue
        if char in "'\"":
            quote = char
            current += char
            index += 1
            continue
        operator = line[index : index + 2] if line[index : index + 2] in ("||", "&&") else ""
        if not operator and char == ";":
            operator = ";"
        if operator:
            found.extend([current, operator])
            current = ""
            index += len(operator)
            continue
        current += char
        index += 1
    found.append(current)
    return [part.strip() for part in found if part.strip()]


def statements(text: str) -> list[str]:
    """Every segment `text` would RUN, in order: continuations joined first."""
    found: list[str] = []
    pending = ""
    for raw in text.splitlines():
        line = uncomment(raw).strip()
        if not line:
            pending = ""
            continue
        if line.endswith("\\"):
            pending += line[:-1].strip() + " "
            continue
        joined = re.sub(r"\s+", " ", (pending + line).strip())
        pending = ""
        found.extend(segments(joined))
    return found


def function_body(text: str, name: str) -> str:
    """The lines of one shell function, and nothing else."""
    lines = text.splitlines()
    opener = f"{name}() {{"
    if opener not in lines:
        raise ValueError(f"{SMOKE_NAME} defines no {name}()")
    start = lines.index(opener)
    for offset in range(start + 1, len(lines)):
        if lines[offset] == "}":
            return "\n".join(lines[start + 1 : offset])
    raise ValueError(f"{SMOKE_NAME}'s {name}() is never closed")


def function_source(text: str, name: str) -> str:
    """The whole function definition, verbatim, ready to be run on its own."""
    return f"{name}() {{\n{function_body(text, name)}\n}}"


def without_container_loop(body: str) -> tuple[str, list[str]]:
    """`body` with the pinned container-log loop lifted out, and why not."""
    lines = body.splitlines()
    if LOOP_HEADER not in lines:
        return body, ["deny() no longer carries the pinned container-log loop"]
    start = lines.index(LOOP_HEADER)
    if LOOP_CLOSE not in lines[start:]:
        return body, ["deny()'s container-log loop is never closed"]
    end = lines.index(LOOP_CLOSE, start)
    block = "\n".join(lines[start : end + 1])
    if block != CONTAINER_LOOP:
        return body, ["deny()'s container-log loop is not the pinned block"]
    return "\n".join(lines[:start] + lines[end + 1 :]), []


def top_level(text: str) -> list[str]:
    """Every segment the script runs OUTSIDE a function, in order."""
    lines = text.splitlines()
    outside: list[str] = []
    index = 0
    while index < len(lines):
        if _FUNCTION.match(lines[index]):
            while index < len(lines) and lines[index] != "}":
                index += 1
            index += 1
            continue
        outside.append(lines[index])
        index += 1
    return statements("\n".join(outside))


def unguarded(body: list[str], head: str) -> list[str]:
    """Every segment starting with `head` that is not followed by `|| true`."""
    return [
        segment
        for position, segment in enumerate(body)
        if segment.startswith(head) and body[position + 1 : position + 3] != ["||", "true"]
    ]


def conditional(body: list[str], segment: str) -> bool:
    """Whether `segment` stands behind `&&` or `||`, so it may not run."""
    position = body.index(segment)
    return position > 0 and body[position - 1] in ("&&", "||")


def refusals(text: str) -> list[str]:
    """Every way this script's DENY account fails to be one."""
    stripped, found = without_container_loop(function_body(text, "deny"))
    body = statements(stripped)

    for segment in body:
        word = segment.split(maxsplit=1)[0]
        if word in CONTROL or word[0] in _CONTROL_OPENERS:
            found.append(
                f"deny() contains control flow; a command inside it is not "
                f"proven to run: {segment!r}"
            )

    reads = [
        segment
        for segment in body
        if segment.startswith("docker run ") and " df " in f" {segment} "
    ]
    if len(reads) != 1:
        found.append(f"deny() runs {len(reads)} volume reads, not exactly one")
    else:
        for needed in (THROWAWAY, BLOBS_MOUNT, JOURNAL_MOUNT, "/data/blobs", "/data/journal"):
            if needed not in reads[0]:
                found.append(f"deny()'s volume read does not name {needed}")
        if conditional(body, reads[0]):
            found.append("deny()'s volume read stands behind an operator; it may not run")
    daemon = [segment for segment in body if segment.startswith("docker system df")]
    if not daemon:
        found.append("deny() prints no docker system df: the daemon's own account")
    elif conditional(body, daemon[0]):
        found.append("deny()'s daemon account stands behind an operator; it may not run")
    for heading in (VOLUME_SPACE_HEADING, SYSTEM_HEADING):
        if not any(heading in segment for segment in body):
            found.append(f"deny() prints no {heading!r} heading")
    for segment in unguarded(body, "docker "):
        found.append(f"deny() runs `{segment}` with no `|| true`; it can mask the refusal")
    last = body[-1] if body else ""
    if last != "exit 1":
        found.append(f"deny() ends with {last!r}, not `exit 1`")

    outside = top_level(text)
    assigned = [i for i, segment in enumerate(outside) if segment.startswith("throwaway=")]
    denies = [i for i, segment in enumerate(outside) if segment.startswith("deny ")]
    if len(assigned) != 1:
        found.append(f"{len(assigned)} top-level throwaway assignments, not exactly one")
    elif not denies:
        found.append("no top-level statement can call deny")
    else:
        if assigned[0] > denies[0]:
            found.append("the throwaway is resolved after a statement that can call deny")
        if THROWAWAY_SOURCE not in outside[assigned[0]]:
            found.append(f"the throwaway does not come from {THROWAWAY_SOURCE}")
        if THROWAWAY_DIGEST not in outside[assigned[0]]:
            found.append("the throwaway is not matched by digest")
    return found


def run_deny(text: str, fail_df: bool = False) -> tuple[int, str, list[tuple[str, ...]]]:
    """Run `deny` in a synthetic world; return its status, stderr and argv log.

    The five variables `deny` reads are bound here, not sourced: the rest of
    the script starts containers, and nothing in this suite may. The only
    `docker` on PATH is a recording stub.
    """
    harness = "\n".join(
        [
            "set -euo pipefail",
            f"container='{STUB_CONTAINER}'",
            f"restored='{STUB_RESTORED}'",
            f"blobs_volume='{STUB_BLOBS}'",
            f"journal_volume='{STUB_JOURNAL}'",
            f"throwaway='{STUB_THROWAWAY}'",
            function_source(text, "deny"),
            f"( deny '{STUB_REASON}' )",
            "",
        ]
    )
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        binaries = root / "bin"
        binaries.mkdir()
        stub = binaries / "docker"
        stub.write_text(DOCKER_STUB, encoding="utf-8")
        stub.chmod(0o755)
        log = root / "calls.log"
        log.write_text("", encoding="utf-8")
        script = root / "deny.sh"
        script.write_text(harness, encoding="utf-8")
        env = {
            "PATH": f"{binaries}{os.pathsep}{os.environ['PATH']}",
            "HOME": str(root),
            "LANG": "C",
            "STUB_LOG": str(log),
        }
        if fail_df:
            env["STUB_DF_FAIL"] = "1"
        result = subprocess.run(
            ["bash", "--noprofile", "--norc", str(script)],
            cwd=str(ROOT),
            env=env,
            capture_output=True,
            text=True,
            timeout=60,
        )
        calls = [
            tuple(line.split("\t"))
            for line in log.read_text(encoding="utf-8").splitlines()
            if line
        ]
    return result.returncode, result.stderr, calls


def script() -> str:
    return SMOKE.read_text(encoding="utf-8")


class TheDenyAccountHoldsItsShape(unittest.TestCase):
    """The shipped script, as it stands, read for structure."""

    def test_the_script_raises_no_refusal(self):
        self.assertEqual(refusals(script()), [])

    def test_the_pinned_loop_is_the_only_control_flow(self):
        stripped, problems = without_container_loop(function_body(script(), "deny"))
        self.assertEqual(problems, [])
        self.assertNotIn("for name in", stripped)
        self.assertNotIn("if ", stripped)


class TheDenyAccountRuns(unittest.TestCase):
    """The shipped script, as it stands, EXECUTED against recording stubs."""

    @classmethod
    def setUpClass(cls):
        if shutil.which("bash") is None:
            raise AssertionError("bash is required to execute deny() (the runner has it)")
        cls.status, cls.stderr, cls.calls = run_deny(script())

    def runs(self, prefix: tuple[str, ...]) -> list[tuple[str, ...]]:
        return [call for call in self.calls if call[: len(prefix)] == prefix]

    def test_deny_exits_one(self):
        self.assertEqual(self.status, 1, self.stderr)
        self.assertNotIn("unbound variable", self.stderr)

    def test_exactly_one_volume_read_carries_everything_it_must(self):
        reads = self.runs(("run",))
        self.assertEqual(len(reads), 1, self.calls)
        argv = reads[0]
        self.assertEqual(argv[-len(DF_ARGV) :], DF_ARGV, argv)
        self.assertIn(STUB_THROWAWAY, argv)
        # Every flag with the value that FOLLOWED it, so a second `--volume`
        # cannot be satisfied by the first one's value.
        pairs = list(zip(argv, argv[1:]))
        for pair in (
            ("--user", "0"),
            ("--volume", f"{STUB_BLOBS}:/data/blobs"),
            ("--volume", f"{STUB_JOURNAL}:/data/journal"),
        ):
            self.assertIn(pair, pairs, f"{pair} missing from {argv}")

    def test_exactly_one_daemon_account(self):
        self.assertEqual(len(self.runs(("system", "df"))), 1, self.calls)

    def test_each_named_container_is_probed_read_and_inspected(self):
        for name in (STUB_CONTAINER, STUB_RESTORED):
            self.assertEqual(self.runs(("container", "inspect", name)), [("container", "inspect", name)])
            self.assertEqual(self.runs(("logs", name)), [("logs", name)])
            formatted = [
                call
                for call in self.runs(("container", "inspect", "--format"))
                if call[-1] == name
            ]
            self.assertEqual(len(formatted), 1, self.calls)

    def test_both_headings_reach_stderr(self):
        self.assertIn(f"image-smoke: DENY {STUB_REASON}", self.stderr)
        self.assertIn(VOLUME_SPACE_HEADING, self.stderr)
        self.assertIn(SYSTEM_HEADING, self.stderr)

    def test_a_failing_volume_read_still_reaches_the_daemon_account_and_exits_one(self):
        status, stderr, calls = run_deny(script(), fail_df=True)
        self.assertEqual(status, 1, stderr)
        self.assertEqual(len([c for c in calls if c[:1] == ("run",)]), 1, calls)
        self.assertEqual(len([c for c in calls if c[:2] == ("system", "df")]), 1, calls)
        self.assertIn(SYSTEM_HEADING, stderr)


class TheParserFindsWhatItClaimsTo(unittest.TestCase):
    """The readers themselves, on inputs whose answer is known."""

    def test_a_comment_is_not_a_command(self):
        self.assertEqual(
            statements("# docker system df\ndocker logs x || true"),
            ["docker logs x", "||", "true"],
        )

    def test_a_trailing_comment_is_cut_and_a_quoted_hash_is_not(self):
        self.assertEqual(uncomment("printf 'a # b' # tail"), "printf 'a # b' ")

    def test_a_continuation_is_one_statement(self):
        self.assertEqual(
            statements("docker run \\\n  --rm \\\n  x df -h /d"),
            ["docker run --rm x df -h /d"],
        )

    def test_an_operator_inside_quotes_separates_nothing(self):
        self.assertEqual(
            segments("""a="$(awk '$1 && $2; exit')" """),
            ["""a="$(awk '$1 && $2; exit')\""""],
        )

    def test_a_function_body_stops_at_its_own_close(self):
        self.assertEqual(function_body("f() {\n  a\n}\nb\n", "f"), "  a")

    def test_a_function_source_round_trips(self):
        self.assertEqual(function_source("f() {\n  a\n}\nb\n", "f"), "f() {\n  a\n}")

    def test_top_level_skips_every_function(self):
        self.assertEqual(top_level("f() {\n  inside\n}\noutside\n"), ["outside"])

    def test_an_unclosed_or_missing_function_is_refused(self):
        with self.assertRaises(ValueError):
            function_body("f() {\n  a\n", "f")
        with self.assertRaises(ValueError):
            function_body("g() {\n}\n", "deny")


class MutatedSmokeIsRefused(unittest.TestCase):
    """Every rule, proven able to fail. In memory; the file is never written."""

    def setUp(self):
        self.text = script()

    def mutate(self, old: str, new: str) -> list[str]:
        self.assertEqual(self.text.count(old), 1, f"{old!r} is not unique")
        return refusals(self.text.replace(old, new, 1))

    def mutated(self, old: str, new: str) -> str:
        self.assertEqual(self.text.count(old), 1, f"{old!r} is not unique")
        return self.text.replace(old, new, 1)

    def kills(self, found: list[str], needle: str) -> None:
        self.assertTrue(
            any(needle in refusal for refusal in found),
            f"no refusal mentioned {needle!r}: {found}",
        )

    def test_the_baseline_is_clean(self):
        self.assertEqual(refusals(self.text), [])

    def test_commenting_the_volume_read_out_is_refused(self):
        # The text stays in the file and only its execution goes: the mutation
        # a whole-file search cannot see.
        found = self.mutate(
            "  docker run --rm --user 0 \\\n"
            '    --volume "${blobs_volume}:/data/blobs" \\\n'
            '    --volume "${journal_volume}:/data/journal" \\\n'
            '    "${throwaway}" df -h /data/blobs /data/journal >&2 2>&1 || true',
            "  # docker run --rm --user 0"
            ' --volume "${blobs_volume}:/data/blobs"'
            ' --volume "${journal_volume}:/data/journal"'
            ' "${throwaway}" df -h /data/blobs /data/journal >&2 2>&1 || true',
        )
        self.kills(found, "0 volume reads")

    def test_skipping_the_volume_read_with_a_false_condition_is_refused(self):
        # Round 1 of #21: the unchanged command, made unreachable. Both readers
        # must answer, because a reader that counts segments cannot.
        skipped = self.mutated(
            "  docker run --rm --user 0 \\\n"
            '    --volume "${blobs_volume}:/data/blobs" \\\n'
            '    --volume "${journal_volume}:/data/journal" \\\n'
            '    "${throwaway}" df -h /data/blobs /data/journal >&2 2>&1 || true',
            "  if false; then\n"
            "  docker run --rm --user 0 \\\n"
            '    --volume "${blobs_volume}:/data/blobs" \\\n'
            '    --volume "${journal_volume}:/data/journal" \\\n'
            '    "${throwaway}" df -h /data/blobs /data/journal >&2 2>&1 || true\n'
            "  fi",
        )
        self.kills(refusals(skipped), "contains control flow")
        status, stderr, calls = run_deny(skipped)
        self.assertEqual(status, 1, stderr)
        self.assertEqual([call for call in calls if call[:1] == ("run",)], [], calls)

    def test_skipping_the_daemon_account_with_a_false_condition_is_refused(self):
        skipped = self.mutated(
            "  docker system df >&2 2>&1 || true",
            "  if false; then\n  docker system df >&2 2>&1 || true\n  fi",
        )
        self.kills(refusals(skipped), "contains control flow")
        status, stderr, calls = run_deny(skipped)
        self.assertEqual(status, 1, stderr)
        self.assertEqual([call for call in calls if call[:2] == ("system", "df")], [], calls)

    def test_a_volume_read_behind_an_operator_is_refused(self):
        found = self.mutate(
            "  docker run --rm --user 0 \\\n",
            "  false && docker run --rm --user 0 \\\n",
        )
        self.kills(found, "stands behind an operator")

    def test_editing_the_pinned_container_loop_is_refused(self):
        found = self.mutate("  docker logs \"${name}\" >&2 2>&1 || true", "  true")
        self.kills(found, "not the pinned block")

    def test_reading_only_one_volume_is_refused(self):
        found = self.mutate(
            '    --volume "${journal_volume}:/data/journal" \\\n'
            '    "${throwaway}" df -h /data/blobs /data/journal',
            '    "${throwaway}" df -h /data/blobs',
        )
        self.kills(found, "/data/journal")

    def test_an_unpinned_throwaway_is_refused(self):
        found = self.mutate('"${throwaway}" df -h', '"caddy:2" df -h')
        self.kills(found, THROWAWAY)

    def test_dropping_the_daemon_account_is_refused(self):
        found = self.mutate("  docker system df >&2 2>&1 || true\n", "")
        self.kills(found, "the daemon's own account")

    def test_a_command_that_can_fail_is_refused(self):
        found = self.mutate(
            "  docker system df >&2 2>&1 || true", "  docker system df >&2 2>&1"
        )
        self.kills(found, "no `|| true`")

    def test_breaking_the_fail_through_is_caught_by_execution(self):
        # `|| true` deleted from the volume read: the structure reader names
        # it, and a failing read now takes the whole account down with it.
        broken = self.mutated(
            '    "${throwaway}" df -h /data/blobs /data/journal >&2 2>&1 || true',
            '    "${throwaway}" df -h /data/blobs /data/journal >&2 2>&1',
        )
        self.kills(refusals(broken), "no `|| true`")
        _status, stderr, calls = run_deny(broken, fail_df=True)
        # The status stays 1 only because the stub's own failure is 1; the
        # account is what is lost, and that is what this asserts.
        self.assertEqual([call for call in calls if call[:2] == ("system", "df")], [], calls)
        self.assertNotIn(SYSTEM_HEADING, stderr)

    def test_changing_the_exit_code_is_refused(self):
        found = self.mutate("  exit 1\n}", "  exit 0\n}")
        self.kills(found, "not `exit 1`")

    def test_dropping_a_heading_is_refused(self):
        found = self.mutate(VOLUME_SPACE_HEADING, "image-smoke: ---")
        self.kills(found, VOLUME_SPACE_HEADING)

    def test_resolving_the_throwaway_after_a_refusal_is_refused(self):
        line = [row for row in self.text.splitlines() if row.startswith("throwaway=")]
        self.assertEqual(len(line), 1)
        anchor = 'docker volume create "${blobs_volume}" >/dev/null'
        moved = self.text.replace(line[0] + "\n", "", 1)
        self.assertEqual(moved.count(anchor), 1)
        found = refusals(moved.replace(anchor, line[0] + "\n" + anchor, 1))
        self.kills(found, "resolved after a statement that can call deny")

    def test_an_unpinned_throwaway_source_is_refused(self):
        found = self.mutate(THROWAWAY_DIGEST, r"^docker\.io\/library\/caddy:")
        self.kills(found, "not matched by digest")


if __name__ == "__main__":
    unittest.main()
