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

FAIL-CLOSED PARSING, OVER EXECUTABLE STRUCTURE. This suite reads the BODY of
the `deny` function and the top-level statements around it, never the whole
file. A pin this repository shipped earlier was a whole-file search that a
comment satisfied, which is a pin that cannot fail. Here continuations are
joined, comments are removed quote-aware, and each logical line is split into
the segments a shell would run -- also quote-aware, because the operators this
file splits on stand inside the awk program that resolves the throwaway. A
command behind a `#` therefore counts for nothing, and a command's `|| true`
is a fact about the segment standing after it.

EVERY RULE HAS A NEGATIVE TEST. `MutatedSmokeIsRefused` re-runs the same
functions over the real script with one property broken -- in memory, never on
disk -- so a rule that stopped being able to fail fails here instead.
"""

from __future__ import annotations

import re
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

_FUNCTION = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*\(\) \{$")


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


def refusals(text: str) -> list[str]:
    """Every way this script's DENY account fails to be one."""
    found: list[str] = []
    body = statements(function_body(text, "deny"))

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
    if not any(segment.startswith("docker system df") for segment in body):
        found.append("deny() prints no docker system df: the daemon's own account")
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


def script() -> str:
    return SMOKE.read_text(encoding="utf-8")


class TheDenyAccountHoldsItsShape(unittest.TestCase):
    """The shipped script, as it stands."""

    def test_the_script_raises_no_refusal(self):
        self.assertEqual(refusals(script()), [])


class TheParserFindsWhatItClaimsTo(unittest.TestCase):
    """The reader itself, on inputs whose answer is known."""

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
        self.assertEqual(segments("""a="$(awk '$1 && $2; exit')" """), ["""a="$(awk '$1 && $2; exit')\""""])

    def test_a_function_body_stops_at_its_own_close(self):
        self.assertEqual(function_body("f() {\n  a\n}\nb\n", "f"), "  a")

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
            '  docker run --rm --user 0 \\\n'
            '    --volume "${blobs_volume}:/data/blobs" \\\n'
            '    --volume "${journal_volume}:/data/journal" \\\n'
            '    "${throwaway}" df -h /data/blobs /data/journal >&2 2>&1 || true',
            '  # docker run --rm --user 0'
            ' --volume "${blobs_volume}:/data/blobs"'
            ' --volume "${journal_volume}:/data/journal"'
            ' "${throwaway}" df -h /data/blobs /data/journal >&2 2>&1 || true',
        )
        self.kills(found, "0 volume reads")

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
