"""`image-smoke.sh` carries two controls: its DENY account, and its ninth
property. Both are pinned here, by two readers that share nothing but the
script. The first subject follows; the second is below it.

`image-smoke.sh`'s DENY account is a control, so it gets a control.

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


SECOND SUBJECT: THE NINTH PROPERTY. Everything above is about `deny`, the
account the smoke prints on its worst day. The rest of this file is about
property 9, the one that makes a bad day happen on purpose.

WHY. Properties 1 to 8 run on volumes with room. Nothing in this repository
proved what the SHIPPED image does when the filesystem itself refuses, and a
full volume is not a hypothetical: it is where a vault that outgrows its claim
ends up, and the readiness answer is what a cluster takes the pod out of
service on. Property 9 exhausts a real volume, requires the server's 503 and
its own `io=StorageFull` line, frees the space, and requires the server ready
again without a restart.

That property is only worth what its weakest half is worth, and every half of
it can be quietly removed while the smoke still prints its green lines:

  - a blob volume created WITHOUT a size option can never be exhausted, so the
    fill succeeds, readiness stays true, and the property proves the opposite
    of what it claims. This is the failure that leaves no trace at all.
  - a fill or a free run from an UNPINNED image is a third-party container
    handed the server's blob volume, which is the helper-container hole the
    onboarding contract closes for the journal volume.
  - dropping the recovery half turns "a full volume refuses and comes back"
    into "a full volume refuses", which is also true of a server that has
    crashed, and of one that never recovers when the operator grows the disk.
  - dropping the requirement on the server's OWN line leaves the HTTP 503,
    which a shutting-down server also answers. The line is what says the
    filesystem returned ENOSPC rather than something else entirely.
  - dropping the hardening flags smokes a container that is not the one the
    chart renders, on the one property most likely to need a write.

WHAT IS PINNED, and against WHAT. Every rule below is decided on the script's
EXECUTABLE structure -- comments dropped, line continuations joined, each
remaining line split into shell tokens -- so no rule can be satisfied by prose
describing what the script would do. `# docker volume create --opt o=size=8m`
is a comment and counts for nothing.

  1. size -- the blob volume property 9 uses is created with `type=tmpfs` and
     an `o=` option carrying `size=`. Without both it is an ordinary volume
     with the host's whole disk behind it.
  2. separate volumes -- the journal is a different volume from the blobs, so
     exhausting the blobs does not also exhaust the journal and the refusal
     names one cause.
  3. hardening -- the run carries `--read-only`, `--cap-drop ALL` and
     `--security-opt no-new-privileges`, as every other property's run does.
  4. pinned filler -- every container that touches that volume other than the
     server itself runs `${throwaway}`, the digest-pinned image the compose
     file names, and never a literal reference or a tag.
  5. the server's own account -- a `grep` in the region asks the container log
     for `event=readiness decision=not_ready volume=blobs io=StorageFull`, and
     another executable line requires the wire refusal `not_ready` naming the
     volume. It must be the grep's own pattern: the same words inside the
     refusal message that fires when the grep fails describe the check without
     being it, which is exactly the shape this suite exists to refuse.
  6. recovery -- an executable line frees the volume through the throwaway,
     and an executable line requires `{"ready":true` afterwards under a
     refusal if it never comes.
  7. the count -- the script calls `prove` exactly `PROPERTIES` times, so the
     SUMMARY line's `properties=` is that number and a property that returns
     without proving anything cannot pass unnoticed.
"""

from __future__ import annotations

import os
import re
import shlex
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


# ---------------------------------------------------------------------------
# The ninth property: a blob volume exhausted for real.
#
# A second reader, deliberately separate from the one above. That one answers
# "does `deny` still run its diagnostics"; this one answers "does property 9
# still exhaust a volume it can exhaust, and still require the recovery". They
# share the script and nothing else, so they share no state here either.
# ---------------------------------------------------------------------------

# Property 9's region: from the command that creates the volume it exhausts to
# the `prove` that closes it. Both ends are executable, so the region cannot be
# moved by editing a comment.
REGION_START = "${full_blobs}"
# ... and it is the `docker volume create` of that name that opens the region,
# not the cleanup trap's `docker volume rm`, which names it far earlier.
REGION_PROOF = "full blob volume:"
# How many properties the script must prove. The SUMMARY prints the count it
# reached, so this is the number a reader of the gate log sees. Property 10 is
# the chart's own rendered environment, run on the shipped image; it stands
# after property 9 so the region above keeps its meaning.
PROPERTIES = 10
# The line the server writes when a volume will not take the readiness probe.
READINESS_LINE = "event=readiness decision=not_ready volume=blobs io=StorageFull"
# The detail the wire refusal carries, and the code it carries it under.
WIRE_DETAIL = "blobs volume is not writable"
WIRE_CODE = "not_ready"
# What a ready answer starts with, matched by the smoke as a `case` pattern.
READY_PREFIX = '{"ready":true'
# The file the fill writes and the free removes.
FILLER = "/data/blobs/filler"
# The digest-pinned throwaway, by the name the script resolves it into.
FILLER_IMAGE = "${throwaway}"
# Each half of property 9 is a poll loop that sets a variable and a guard that
# refuses when the loop never set it, and BOTH have to be pinned. A loop whose
# pattern matches anything, and a guard that cannot fail, are each a property
# that stays green having proved nothing -- and neither shows up as a missing
# line, which is why presence was not enough. Per half: the variable, the
# token the loop must match on (`None` where rule 5's grep is that token), and
# whether the refusal must name the budget it waited against.
GUARDS = (
    ("refused", '*"not_ready"*)', True),
    ("said", None, False),
    ("recovered", '{"ready":true*)', True),
)
# The budget a wait is measured against (AGENTS.md requirement 12).
BUDGET = "${READY_BUDGET_SECONDS}"
# A guard whose alternative is one of these refuses nothing at all.
NEVER_REFUSES = ("true", ":")

# The mutation anchors, lifted verbatim out of `image-smoke.sh` at the time
# this file was written, so a hand-typed near-miss cannot silently stop
# matching and turn a negative test into one that proves nothing. `mutate`
# asserts each one is unique before it applies it.
RECOVERY_TEST = '[ -n "${recovered}" ] \\\n'
RECOVERY_DENY = '  || deny "the server did not become ready again within ${READY_BUDGET_SECONDS}s of the volume being freed: \'${body}\'"\n'
REFUSED_TEST = '[ -n "${refused}" ] \\\n'
REFUSED_DENY = '  || deny "a full blob volume was still answering ready after ${READY_BUDGET_SECONDS}s: \'${body}\'"\n'
REFUSED_PATTERN = '    *\'"not_ready"\'*) refused="${body}"; break ;;\n'
SAID_DENY = '  || { printf \'image-smoke: full-volume server log:\\n%s\\n\' "$(docker logs "${full}" 2>&1 | tail -n 20)"; \\\n       deny \'the server did not say what the full blob volume returned (event=readiness decision=not_ready volume=blobs io=StorageFull)\'; }'
# The hardening every run in this script carries.
HARDENING = (
    ("--read-only",),
    ("--cap-drop", "ALL"),
    ("--security-opt", "no-new-privileges"),
)


def commands(text: str) -> list[list[str]]:
    """The script's executable lines, as shell tokens.

    Continuations are joined first, so a command spread over ten lines is one
    command. Whole-line comments are dropped, and `shlex` drops anything after
    an unquoted `#`, so a rule can never be satisfied by a description of the
    command it is looking for.
    """
    joined = re.sub(r"\\\n[ \t]*", " ", text)
    out: list[list[str]] = []
    for raw in joined.splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or line.startswith("#!"):
            continue
        try:
            tokens = shlex.split(line, comments=True)
        except ValueError:
            # An unbalanced quote across a construct this reader does not
            # follow. It carries no rule; a rule that needed it would be
            # missing instead, which refuses.
            continue
        if tokens:
            out.append(tokens)
    return out


def region(text: str) -> list[list[str]]:
    """Property 9's own commands, in order."""
    all_commands = commands(text)
    start = next(
        (
            i
            for i, c in enumerate(all_commands)
            if _creates_volume(c) and any(REGION_START in t for t in c)
        ),
        None,
    )
    if start is None:
        return []
    end = next(
        (
            i
            for i, c in enumerate(all_commands)
            if i > start and c[0] == "prove" and c[1:2] and c[1].startswith(REGION_PROOF)
        ),
        None,
    )
    if end is None:
        return []
    return all_commands[start : end + 1]


def _runs(command: list[str]) -> bool:
    return command[:2] == ["docker", "run"]


def _creates_volume(command: list[str]) -> bool:
    return command[:3] == ["docker", "volume", "create"]


def _options(command: list[str]) -> list[str]:
    """The values of every `--opt` flag, in order."""
    return [
        command[i + 1]
        for i, token in enumerate(command)
        if token == "--opt" and i + 1 < len(command)
    ]


def _mounts(command: list[str]) -> list[str]:
    return [
        command[i + 1]
        for i, token in enumerate(command)
        if token == "--volume" and i + 1 < len(command)
    ]


def _mounted_at(command: list[str], destination: str) -> str | None:
    for mount in _mounts(command):
        source, _, dest = mount.partition(":")
        if dest == destination:
            return source
    return None


def _has_flag(command: list[str], pair: tuple[str, ...]) -> bool:
    if len(pair) == 1:
        return pair[0] in command
    flag, value = pair
    return any(
        token == flag and command[i + 1 : i + 2] == [value]
        for i, token in enumerate(command)
    )


def _image_of(command: list[str]) -> str | None:
    """The image a `docker run` names: the last token that is not a flag, a
    flag's value, or the command the container runs."""
    skip = {"--volume", "--env", "--name", "--publish", "--security-opt", "--cap-drop",
            "--user", "--opt", "--driver"}
    i = 2
    while i < len(command):
        token = command[i]
        if token in skip:
            i += 2
            continue
        if token.startswith("-"):
            i += 1
            continue
        return token
    return None


def _mentions(commands_: list[list[str]], needle: str) -> bool:
    return any(any(needle in token for token in c) for c in commands_)


def _sets(block: list[list[str]], var: str) -> list[list[str]]:
    """The commands that give `var` a value other than its empty initialiser."""
    empty = f"{var}=''"
    return [
        c
        for c in block
        if any(t.startswith(f"{var}=") and t != empty and t != f"{var}=" for t in c)
    ]


def _guards(block: list[list[str]], var: str) -> list[list[str]]:
    """The commands that refuse when `var` was never set.

    Matched on MENTIONING the variable rather than on holding it as an exact
    token: `[ -n "${recovered}x" ]` is a guard that can never fail, and the
    rule that judges the test is only reached if this finds it.
    """
    name = "${" + var + "}"
    return [
        c for c in block if c and c[0] == "[" and "||" in c and any(name in t for t in c)
    ]


def _split_on_or(command: list[str]) -> tuple[list[str], list[str]]:
    """A guard's test, and what runs when the test fails."""
    at = command.index("||")
    return command[:at], command[at + 1 :]


def ninth_refusals(text: str) -> list[str]:
    """Everything wrong with the ninth property, one string per rule."""
    found: list[str] = []
    block = region(text)
    if not block:
        return [f"{SMOKE_NAME}: no ninth property (nothing creates {REGION_START})"]

    # 1 and 2: the volumes it runs on.
    created = [c for c in block if _creates_volume(c)]
    sized = [
        c
        for c in created
        if any(REGION_START in t for t in c)
        and any("type=tmpfs" in o for o in _options(c))
        and any(o.startswith("o=") and "size=" in o for o in _options(c))
    ]
    if not sized:
        found.append(
            f"{SMOKE_NAME}: the volume property 9 exhausts is not created with "
            "type=tmpfs and an o= option carrying size="
        )

    servers = [c for c in block if _runs(c) and "--detach" in c]
    if len(servers) != 1:
        found.append(f"{SMOKE_NAME}: property 9 starts {len(servers)} servers, not 1")
    for server in servers:
        blobs = _mounted_at(server, "/data/blobs")
        journal = _mounted_at(server, "/data/journal")
        if blobs is None or REGION_START not in blobs:
            found.append(
                f"{SMOKE_NAME}: property 9's server does not mount the volume it exhausts"
            )
        if journal is None:
            found.append(f"{SMOKE_NAME}: property 9's server mounts no journal volume")
        elif journal == blobs:
            found.append(
                f"{SMOKE_NAME}: property 9 puts the journal on the volume it exhausts"
            )
        # 3: the hardening.
        for pair in HARDENING:
            if not _has_flag(server, pair):
                found.append(
                    f"{SMOKE_NAME}: property 9's server runs without {' '.join(pair)}"
                )

    # 4: everything else that touches that volume is the pinned throwaway.
    for c in block:
        if not _runs(c) or "--detach" in c:
            continue
        if _mounted_at(c, "/data/blobs") is None:
            continue
        if _image_of(c) != FILLER_IMAGE:
            found.append(
                f"{SMOKE_NAME}: property 9 touches the blob volume with "
                f"{_image_of(c)!r}, not the digest-pinned {FILLER_IMAGE}"
            )

    # 5: the server's own account, and the wire refusal. The line must be what
    # a `grep` actually asks the container log for -- naming it in the refusal
    # message that fires when the grep fails is a description, not a check.
    greps = [c for c in block if "grep" in c and any(READINESS_LINE in t for t in c)]
    if not greps:
        found.append(
            f"{SMOKE_NAME}: property 9 does not require the server's own line "
            f"({READINESS_LINE})"
        )
    if not _mentions(block, WIRE_CODE) or not _mentions(block, WIRE_DETAIL):
        found.append(
            f"{SMOKE_NAME}: property 9 does not require the wire refusal "
            f"({WIRE_CODE}, {WIRE_DETAIL})"
        )

    # 5b: every half REFUSES. For each, the loop matches on the one pattern
    # that means what the half claims, and the guard is exactly
    # `[ -n "${var}" ] || deny …`: a test that cannot fail and an alternative
    # that refuses nothing are the two ways to keep a green line while the
    # property stops being a property.
    for var, pattern, budget in GUARDS:
        if pattern is not None:
            setters = _sets(block, var)
            if not setters:
                found.append(f"{SMOKE_NAME}: nothing in property 9 sets {var}")
            elif not any(c[0] == pattern for c in setters):
                found.append(
                    f"{SMOKE_NAME}: property 9 sets {var} on {setters[0][0]!r}, "
                    f"not on {pattern!r}; a looser pattern matches an answer "
                    "that is not the one the property claims"
                )
        guards = _guards(block, var)
        if len(guards) != 1:
            found.append(
                f"{SMOKE_NAME}: property 9 has {len(guards)} refusals for {var}, not 1"
            )
            continue
        test, alternative = _split_on_or(guards[0])
        if test != ["[", "-n", "${" + var + "}", "]"]:
            found.append(
                f"{SMOKE_NAME}: property 9's {var} refusal tests {' '.join(test)!r}, "
                f'not `[ -n "${{{var}}}" ]`; a test that cannot fail refuses nothing'
            )
        if "deny" not in alternative:
            found.append(
                f"{SMOKE_NAME}: property 9's {var} refusal does not reach `deny`"
            )
        if any(word in alternative for word in NEVER_REFUSES):
            found.append(
                f"{SMOKE_NAME}: property 9's {var} refusal is satisfied by "
                f"{[w for w in NEVER_REFUSES if w in alternative]}, so it never fires"
            )
        if budget and not any(BUDGET in token for token in alternative):
            found.append(
                f"{SMOKE_NAME}: property 9's {var} refusal does not name the "
                f"budget it waited against ({BUDGET})"
            )

    # 6: recovery. The free itself, and the requirement that ready returns.
    freed = [
        c
        for c in block
        if _runs(c) and _mounted_at(c, "/data/blobs") is not None and _mentions([c], FILLER)
        and "rm" in c
    ]
    if not freed:
        found.append(
            f"{SMOKE_NAME}: property 9 never frees the volume again, so it proves "
            "a refusal and not a recovery"
        )
    # ...and that the recovery is required AFTER it, not before: a ready
    # answer read before the volume was freed is the answer from the run that
    # had not filled it yet.
    after = block[block.index(freed[0]) :] if freed else []
    if not _sets(after, "recovered"):
        found.append(
            f"{SMOKE_NAME}: property 9 does not require {READY_PREFIX} after the "
            "volume is freed"
        )

    # 7: the count the SUMMARY prints.
    proofs = [c for c in commands(text) if c[0] == "prove"]
    if len(proofs) != PROPERTIES:
        found.append(
            f"{SMOKE_NAME}: the smoke proves {len(proofs)} properties, not {PROPERTIES}"
        )
    return found


class ImageSmokeContract(unittest.TestCase):
    """The shipped smoke, and the mutations that must not pass it."""

    maxDiff = None

    def setUp(self):
        self.text = SMOKE.read_text(encoding="utf-8")

    def mutate(self, old: str, new: str) -> list[str]:
        """Apply one edit to a scratch copy and re-decide every rule."""
        self.assertEqual(
            self.text.count(old), 1, f"the mutation anchor is not unique: {old!r}"
        )
        return ninth_refusals(self.text.replace(old, new))

    def kills(self, found: list[str], needle: str):
        self.assertTrue(
            any(needle in f for f in found),
            f"no refusal naming {needle!r}; got {found}",
        )

    def test_the_shipped_smoke_satisfies_every_rule(self):
        self.assertEqual(ninth_refusals(self.text), [])

    def test_the_reader_sees_commands_and_not_comments(self):
        # The whole suite rests on this: a comment describing the command is
        # not the command. Both spellings of a comment are dropped.
        script = "# docker run --read-only image\ndocker run image  # --read-only\n"
        self.assertEqual(commands(script), [["docker", "run", "image"]])
        # And a continuation is one command, not two.
        self.assertEqual(
            commands("docker run \\\n  --read-only \\\n  image\n"),
            [["docker", "run", "--read-only", "image"]],
        )

    def test_an_unbounded_blob_volume_is_refused(self):
        # The quietest failure of all: the fill succeeds, readiness never
        # drops, and the property prints its green line having proven nothing.
        found = self.mutate(
            '--opt "o=size=${FULL_BLOBS_SIZE},mode=0700,uid=65532,gid=65532"',
            '--opt "o=mode=0700,uid=65532,gid=65532"',
        )
        self.kills(found, "size=")

    def test_dropping_the_recovery_half_is_refused(self):
        # "A full volume refuses" is also true of a server that never comes
        # back when the operator grows the disk.
        found = self.mutate("  rm -f /data/blobs/filler \\\n", "  true \\\n")
        self.kills(found, "never frees the volume again")

    def test_a_recovery_pattern_that_matches_something_else_is_refused(self):
        found = self.mutate(
            "    '{\"ready\":true'*) recovered=\"${body}\"; break ;;\n",
            "    'nothing-matches-this'*) recovered=\"${body}\"; break ;;\n",
        )
        self.kills(found, "a looser pattern")

    # --- the three halves must REFUSE, not merely exist ---------------------
    #
    # The reviewer's finding: the suite stayed green when the final recovery
    # assertion was made unconditional. Dropping a half is one mutation and it
    # was caught; keeping the half and making its guard vacuous is a different
    # one, it leaves every line in place, and it was not.

    def test_an_unconditional_recovery_assertion_is_refused(self):
        # The reviewer's own shape: the guard stands and refuses nothing.
        found = self.mutate(RECOVERY_DENY, "  || true\n")
        self.kills(found, "does not reach `deny`")

    def test_a_recovery_test_that_cannot_fail_is_refused(self):
        # The other half of the same trick: leave `deny` in place and make the
        # test true whatever the loop did.
        found = self.mutate(RECOVERY_TEST, '[ -n "${recovered}x" ] \\\n')
        self.kills(found, "refuses nothing")

    def test_a_recovery_refusal_that_hides_its_budget_is_refused(self):
        found = self.mutate(
            "within ${READY_BUDGET_SECONDS}s of the volume being freed",
            "eventually, of the volume being freed",
        )
        self.kills(found, "does not name the budget")

    def test_an_unconditional_503_assertion_is_refused(self):
        found = self.mutate(REFUSED_DENY, "  || true\n")
        self.kills(found, "does not reach `deny`")

    def test_a_503_test_that_cannot_fail_is_refused(self):
        found = self.mutate(REFUSED_TEST, '[ -n "${refused}x" ] \\\n')
        self.kills(found, "refuses nothing")

    def test_a_loosened_503_pattern_is_refused(self):
        found = self.mutate(REFUSED_PATTERN, '    *) refused="${body}"; break ;;\n')
        self.kills(found, "a looser pattern")

    def test_an_unconditional_log_line_assertion_is_refused(self):
        found = self.mutate(SAID_DENY, "  || true")
        self.kills(found, "does not reach `deny`")

    # --- restored ------------------------------------------------------------
    #
    # These five negatives stood before the round-2 repair and were deleted by
    # it, while the validators they protect stayed. The round-2 verdict found
    # the consequence by mutating the SUITE rather than the script: emptying
    # `HARDENING`, and making `_image_of` return the pinned filler
    # unconditionally, each left all 48 tests passing. A validator with no
    # negative is a rule that cannot fail, which is the same defect the
    # recovery guard had. Never delete a negative again without saying so.

    def test_an_unpinned_filler_image_is_refused(self):
        found = self.mutate(
            'docker run --rm --user 0 --volume "${full_blobs}:/data/blobs" "${throwaway}" \\\n  rm -f',
            'docker run --rm --user 0 --volume "${full_blobs}:/data/blobs" busybox:latest \\\n  rm -f',
        )
        self.kills(found, "not the digest-pinned")

    def test_dropping_the_servers_own_line_is_refused(self):
        # The HTTP 503 alone is also what a shutting-down server answers.
        found = self.mutate(f"grep -q '{READINESS_LINE}'", "grep -q 'event=readiness'")
        self.kills(found, "the server's own line")

    def test_running_the_ninth_property_unhardened_is_refused(self):
        found = self.mutate(
            '  --volume "${full_blobs}:/data/blobs" \\\n'
            '  --volume "${full_journal}:/data/journal" \\\n',
            '  --volume "${full_blobs}:/data/blobs" \\\n'
            '  --volume "${full_journal}:/data/journal" \\\n'
            "  --cap-add SYS_ADMIN \\\n",
        )
        self.assertEqual(found, [], "adding a capability is not what this rule reads")
        found = self.mutate(
            "  --read-only \\\n"
            "  --cap-drop ALL \\\n"
            "  --security-opt no-new-privileges \\\n"
            '  --volume "${full_blobs}:/data/blobs" \\\n',
            '  --volume "${full_blobs}:/data/blobs" \\\n',
        )
        self.kills(found, "runs without --read-only")

    def test_putting_the_journal_on_the_volume_that_is_exhausted_is_refused(self):
        found = self.mutate(
            '  --volume "${full_journal}:/data/journal" \\\n',
            '  --volume "${full_blobs}:/data/journal" \\\n',
        )
        self.kills(found, "puts the journal on the volume it exhausts")

    def test_a_property_that_proves_nothing_is_refused(self):
        found = self.mutate('prove "full blob volume:', 'true "full blob volume:')
        self.kills(found, "no ninth property")

    # --- and the two validators that had no negative at all -----------------

    def test_a_server_that_does_not_mount_the_exhausted_volume_is_refused(self):
        found = self.mutate(
            '  --volume "${full_blobs}:/data/blobs" \\\n'
            '  --volume "${full_journal}:/data/journal" \\\n'
            '  --env "OBSYNC_BLOBS_CAPACITY',
            '  --volume "${full_journal}:/data/journal" \\\n'
            '  --env "OBSYNC_BLOBS_CAPACITY',
        )
        self.kills(found, "does not mount the volume it exhausts")

    def test_dropping_the_wire_refusal_is_refused(self):
        found = self.mutate(WIRE_DETAIL, "the volume said something")
        self.kills(found, "does not require the wire refusal")


# ---------------------------------------------------------------------------
# The ninth property, EXECUTED.
#
# The reader above judges the script's shape. A shape can be right while the
# property still cannot fail, which is exactly what the round-1 verdict found:
# replacing `[ -n "${recovered}" ]` with unconditional success left every
# structural rule green and let the real smoke time out waiting for recovery
# and print its ninth proof anyway. So the property is also RUN -- against
# stubs, never a container runtime -- in three worlds where it must refuse,
# and the mutation that made it unfalsifiable is run in the same worlds and
# must reach `prove`, which is what says these three cases have teeth.
# ---------------------------------------------------------------------------

# The `curl` stub answers from a script of bodies, one per call, the last one
# repeating: that is exactly the shape of a poll loop's world.
CURL_STUB = r"""#!/bin/sh
n=0
if [ -f "${STUB_CURL_N}" ]; then n=$(cat "${STUB_CURL_N}"); fi
n=$((n + 1))
printf '%s' "${n}" > "${STUB_CURL_N}"
total=$(grep -c '' "${STUB_CURL_BODIES}")
if [ "${n}" -gt "${total}" ]; then n="${total}"; fi
sed -n "${n}p" "${STUB_CURL_BODIES}"
exit 0
"""

# `docker` answers everything property 9 asks of it, and records nothing:
# what this harness judges is the script's own control flow.
NINTH_DOCKER_STUB = r"""#!/bin/sh
case "$1 $2" in
  'port 8080/tcp'*) printf '127.0.0.1:1\n'; exit 0 ;;
esac
case "$1" in
  port) printf '127.0.0.1:1\n'; exit 0 ;;
  logs) cat "${STUB_LOGS}"; exit 0 ;;
  container)
    case "$2" in
      inspect) printf 'running\n'; exit 0 ;;
    esac
    exit 0 ;;
  volume|run|stop|rm|image) exit 0 ;;
esac
exit 0
"""

# A ready answer, the 503 the full volume gives, and the log line the server
# writes beside it. The bodies a world is built from.
READY_BODY = '{"ready":true,"seq":0}'
NOT_READY_BODY = '{"error":"not_ready","detail":"blobs volume is not writable"}'


def ninth_source(text: str) -> str:
    """Property 9's own lines, from its first command to its `prove`."""
    start = text.index("docker volume create --driver local")
    end = text.index('prove "full blob volume:', start)
    end = text.index("\n", end) + 1
    return text[start:end]


def run_ninth(text: str, bodies: list[str], log_line: bool = True) -> tuple[int, str]:
    """Run property 9 against a scripted world; return its status and output.

    Nothing here starts a container: `docker` and `curl` are stubs, `sleep` is
    a no-op so a 60 s budget costs nothing, and `deny` and `prove` are the
    script's own words reduced to what this judges -- did it refuse, and did
    it reach the ninth proof.
    """
    harness = "\n".join(
        [
            "set -euo pipefail",
            "image='obsync:stub'",
            "full='smoke-full'",
            "full_blobs='smoke-full-blobs'",
            "full_journal='smoke-full-journal'",
            f"throwaway='{STUB_THROWAWAY}'",
            "BLOBS_CAPACITY='1GiB'",
            "JOURNAL_CAPACITY='256MiB'",
            "FULL_BLOBS_SIZE='8m'",
            "READY_BUDGET_SECONDS=3",
            "proven=8",
            "sleep() { :; }",
            "prove() { proven=$((proven + 1)); printf 'PROVEN %s\\n' \"$1\"; }",
            "deny() { printf 'DENY %s\\n' \"$1\" >&2; exit 1; }",
            ninth_source(text),
            "",
        ]
    )
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        binaries = root / "bin"
        binaries.mkdir()
        for name, body in (("docker", NINTH_DOCKER_STUB), ("curl", CURL_STUB)):
            stub = binaries / name
            stub.write_text(body, encoding="utf-8")
            stub.chmod(0o755)
        (root / "bodies").write_text("\n".join(bodies) + "\n", encoding="utf-8")
        (root / "logs").write_text(
            (READINESS_LINE + "\n") if log_line else "nothing of the sort\n",
            encoding="utf-8",
        )
        script_path = root / "ninth.sh"
        script_path.write_text(harness, encoding="utf-8")
        result = subprocess.run(
            ["bash", "--noprofile", "--norc", str(script_path)],
            cwd=str(ROOT),
            env={
                "PATH": f"{binaries}{os.pathsep}{os.environ['PATH']}",
                "HOME": str(root),
                "LANG": "C",
                "STUB_CURL_BODIES": str(root / "bodies"),
                "STUB_CURL_N": str(root / "n"),
                "STUB_LOGS": str(root / "logs"),
            },
            capture_output=True,
            text=True,
            timeout=120,
        )
    return result.returncode, result.stdout + result.stderr


# The three worlds. Each is the poll answers `curl` gives, in order, the last
# repeating for the rest of that loop's budget.
WORLD_HAPPY = [READY_BODY, NOT_READY_BODY, READY_BODY]
WORLD_NEVER_RECOVERS = [READY_BODY, NOT_READY_BODY, NOT_READY_BODY]
WORLD_NEVER_FULL = [READY_BODY, READY_BODY, READY_BODY]


class TheNinthPropertyRuns(unittest.TestCase):
    """The property, executed. No container runtime is touched."""

    def setUp(self):
        self.text = SMOKE.read_text(encoding="utf-8")

    def proves(self, status: int, output: str):
        self.assertEqual(status, 0, output)
        self.assertIn("PROVEN full blob volume", output)

    def refuses(self, status: int, output: str, because: str):
        self.assertNotEqual(status, 0, f"it passed: {output}")
        self.assertIn("DENY", output)
        self.assertIn(because, output)
        self.assertNotIn(
            "PROVEN full blob volume",
            output,
            "a property that refused must not also print its proof",
        )

    def test_a_volume_that_fills_and_frees_reaches_the_ninth_proof(self):
        # The baseline the three refusals are measured against: without it,
        # a property that refused everything would look perfect.
        self.proves(*run_ninth(self.text, WORLD_HAPPY))

    def test_a_volume_that_never_recovers_cannot_reach_the_proof(self):
        status, output = run_ninth(self.text, WORLD_NEVER_RECOVERS)
        self.refuses(status, output, "did not become ready again")

    def test_a_volume_that_never_refuses_cannot_reach_the_proof(self):
        status, output = run_ninth(self.text, WORLD_NEVER_FULL)
        self.refuses(status, output, "still answering ready")

    def test_a_server_that_never_said_why_cannot_reach_the_proof(self):
        status, output = run_ninth(self.text, WORLD_HAPPY, log_line=False)
        self.refuses(status, output, "did not say what the full blob volume returned")

    def test_the_unconditional_recovery_guard_would_have_passed(self):
        # The round-1 finding, executed rather than argued: with the guard
        # made unconditional, the world where recovery never comes reaches
        # the ninth proof. That is what the three cases above now stop, and
        # this is the proof they are not vacuous.
        mutated = self.text.replace(RECOVERY_DENY, "  || true\n")
        self.assertNotEqual(mutated, self.text, "the mutation anchor still matches")
        status, output = run_ninth(mutated, WORLD_NEVER_RECOVERS)
        self.assertEqual(status, 0, output)
        self.assertIn(
            "PROVEN full blob volume",
            output,
            "the mutant is meant to pass here; if it does not, these cases "
            "are proving something other than the guard",
        )


if __name__ == "__main__":
    unittest.main()
