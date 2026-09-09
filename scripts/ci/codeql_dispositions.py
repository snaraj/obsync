#!/usr/bin/env python3
"""Which CodeQL alerts a reviewed disposition covers, and what `main` dismisses.

WHY THIS EXISTS. Every alert this repository has accepted was accepted by hand:
seventy-seven test-vector and cleartext-logging alerts clicked away in the UI,
one more by an agent's API call, and one left open because the last dismissal
was waiting on the owner. A hand dismissal is unreviewed, unrecorded in the
tree, and invisible to the next reader, so a Ready condition of "zero open
alerts" rested on nobody having forgotten. The owner's ruling (issue #22) is
that CodeQL keeps scanning everything and that nobody dismisses by hand.

WHAT REPLACES IT. `security/codeql-dispositions.json` records each accepted
alert CLASS -- rule, a glob over tracked files, an optional scope, one of
CodeQL's own three dismissal reasons, the sentence the dismissal will carry,
and the issue that holds the reasoning. This module decides three things about
that file, offline, and the workflow does every piece of I/O:

  validate  the file is well formed, every glob names a place that exists, and
            no entry dismisses product code as `used in tests`;
  check     every OPEN alert on the analysed ref is covered by some entry --
            an uncovered alert exits 1 and is named, which is what turns a new
            real finding into a red gate rather than a click;
  plan      what `main` will dismiss, one JSON object per covered alert.

WHY THE PARSING IS CLOSED. The disposition file is the authority for silencing
a security tool, so an unknown key, a wrong type, a wildcard rule id, a glob
with no literal segment, or a comment that would arrive truncated is a refusal
that names the field -- never a default and never a shrug. The alert listing
comes from an API and is read with the same suspicion: an alert that is not
`open`, or whose analysed ref is not the one the caller asked about, is a
refusal rather than something quietly skipped, because either means the caller
is judging a listing it did not ask for. A flagged path is read only from
inside the tree it was given.

WHY THE SCOPES ARE NARROW. `line_contains` pins a disposition to the source
line CodeQL actually flagged, so an entry over `storage/mod.rs` stops covering
anything the moment the salt constant it names moves away from the alert.
`within: test-module` covers a Rust file's TRAILING `#[cfg(test)] mod` and
nothing above it -- never merely the first `#[cfg(test)]`, which in this
codebase sits on a fake clock at `api/auth.rs:59` -- so a test vector is
dismissible and the same rule firing on product code in the same file is not.
`used in tests` is refused outright over product code: the reason has to be
true.

Standard library only (requirement 5); no network, no environment reads, no
clock. Refusals are `Refusal` exceptions carrying one sentence.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from dataclasses import dataclass
from pathlib import Path

# CodeQL's own three dismissal reasons; the API accepts no others.
REASONS = ("false positive", "used in tests", "won't fix")
RULE_RE = re.compile(r"^[a-z-]+/[a-z0-9-]+$")
DISPOSITION_RE = re.compile(r"^https://github\.com/snaraj/obsync/issues/[1-9][0-9]*$")
SEGMENT_RE = re.compile(r"^[A-Za-z0-9_.*-]+$")
REQUIRED_FIELDS = ("rule", "path", "reason", "comment", "disposition")
SCOPE_FIELDS = ("line_contains", "within")
WITHIN_VALUES = ("test-module",)
TEST_MODULE_MARKER = "#[cfg(test)]"
# The GitHub API truncates a longer `dismissed_comment`, so the sentence a
# reader sees would stop mattering silently. 280 is the whole composed string.
COMMENT_MAX = 280
DISPOSITION_JOIN = " Disposition: "
MIN_TOKEN = 4
MAIN_REF = "refs/heads/main"
# Where a `used in tests` dismissal may point without a `within` scope. Every
# one of these is compiled only under a test configuration or run only by the
# test command; none of them ships.
TEST_LOCATIONS = (
    "**/tests.rs",
    "**/*_test.rs",
    "plugin/test/**",
    "dashboard/test/**",
    "scripts/ci/test_*.py",
)


class Refusal(Exception):
    """One sentence naming the field, entry, or alert that failed."""


def _object(value: object, what: str) -> dict:
    if not isinstance(value, dict):
        raise Refusal(f"{what} is not an object")
    return value


def _glob_regex(pattern: str, what: str) -> tuple[re.Pattern[str], int]:
    """Translate one path glob, and count the segments that are literal.

    Translation only. The policy that a DISPOSITION's glob must carry at least
    one literal segment lives in `compile_glob`, so the fixed test-location
    list below -- which is reviewed here rather than authored in a data file --
    can use the same semantics without that rule being weakenable from a call
    site.
    """
    if not pattern or pattern.startswith("/") or pattern.endswith("/"):
        raise Refusal(f"{what} is not a relative path glob: {pattern!r}")
    parts = pattern.split("/")
    literal = 0
    expression = ""
    for position, part in enumerate(parts):
        last = position == len(parts) - 1
        if part in {"", ".", ".."}:
            raise Refusal(f"{what} has an empty or relative segment: {pattern!r}")
        if not SEGMENT_RE.match(part):
            raise Refusal(f"{what} has an unmodelled character in segment {part!r}")
        if part == "**":
            # Zero or more whole segments. As the last part it must still cover
            # at least one file name, so a directory alone never matches.
            expression += "(?:[^/]+/)*[^/]+" if last else "(?:[^/]+/)*"
            continue
        if "**" in part:
            raise Refusal(f"{what} uses `**` inside a segment: {part!r}")
        if "*" not in part:
            literal += 1
        expression += re.escape(part).replace(r"\*", "[^/]*")
        if not last:
            expression += "/"
    return re.compile(expression), literal


def compile_glob(pattern: str, what: str) -> re.Pattern[str]:
    """A path glob where `*` stays inside one segment and `**` crosses them.

    A glob with no literal segment -- a bare `**`, or `*/*.rs` -- is refused:
    it names a shape rather than a place, and a disposition that names no place
    silences whatever the tree grows next.
    """
    glob, literal = _glob_regex(pattern, what)
    if literal == 0:
        raise Refusal(f"{what} has no literal segment, so it names no place: {pattern!r}")
    return glob


_TEST_LOCATION_GLOBS = tuple(_glob_regex(p, "test location")[0] for p in TEST_LOCATIONS)


def _is_test_location(path: str) -> bool:
    return any(glob.fullmatch(path) for glob in _TEST_LOCATION_GLOBS)


@dataclass(frozen=True)
class Entry:
    """One reviewed disposition, already validated against the tracked tree."""

    index: int
    rule: str
    path: str
    glob: re.Pattern[str]
    line_contains: str | None
    within: str | None
    reason: str
    comment: str
    disposition: str
    matches: int

    @property
    def dismissal_comment(self) -> str:
        return f"{self.comment}{DISPOSITION_JOIN}{self.disposition}"

    def scope(self) -> str:
        if self.line_contains is not None:
            return f"line_contains={self.line_contains}"
        if self.within is not None:
            return f"within={self.within}"
        return "path"


@dataclass(frozen=True)
class Alert:
    """The facts a disposition decision needs about one open alert."""

    number: int
    rule: str
    path: str
    line: int
    ref: str

    def __str__(self) -> str:
        return f"#{self.number} {self.rule} {self.path}:{self.line}"


def _entry(raw: object, index: int, tracked: list[str]) -> Entry:
    where = f"entry {index}"
    if not isinstance(raw, dict):
        raise Refusal(f"{where} is not an object")
    unknown = sorted(set(raw) - set(REQUIRED_FIELDS) - set(SCOPE_FIELDS))
    if unknown:
        raise Refusal(f"{where} has unknown field(s): {', '.join(unknown)}")
    for field in REQUIRED_FIELDS:
        if field not in raw:
            raise Refusal(f"{where} is missing field {field}")
    for field in REQUIRED_FIELDS + SCOPE_FIELDS:
        if field in raw and not isinstance(raw[field], str):
            raise Refusal(f"{where} field {field} is not a string")

    rule = raw["rule"]
    if not RULE_RE.match(rule):
        raise Refusal(f"{where} field rule is not one exact CodeQL rule id: {rule!r}")

    present = [field for field in SCOPE_FIELDS if field in raw]
    if len(present) > 1:
        raise Refusal(f"{where} carries {' and '.join(present)}; an entry has at most one scope")
    line_contains = raw.get("line_contains")
    if line_contains is not None and len(line_contains) < MIN_TOKEN:
        raise Refusal(f"{where} field line_contains must be at least {MIN_TOKEN} characters")
    if line_contains is not None and line_contains.strip() != line_contains:
        raise Refusal(f"{where} field line_contains is not a trimmed token")
    within = raw.get("within")
    if within is not None and within not in WITHIN_VALUES:
        raise Refusal(f"{where} field within must be one of {', '.join(WITHIN_VALUES)}")

    reason = raw["reason"]
    if reason not in REASONS:
        raise Refusal(f"{where} field reason must be one of {', '.join(repr(r) for r in REASONS)}")

    comment = raw["comment"]
    if not comment:
        raise Refusal(f"{where} field comment is empty")
    if comment.strip() != comment or "\n" in comment or "\r" in comment:
        raise Refusal(f"{where} field comment is not a single trimmed line")
    if len(comment) > COMMENT_MAX:
        raise Refusal(f"{where} field comment is longer than {COMMENT_MAX} characters")

    disposition = raw["disposition"]
    if not DISPOSITION_RE.match(disposition):
        raise Refusal(
            f"{where} field disposition is not an issue in this repository: {disposition!r}"
        )
    composed = f"{comment}{DISPOSITION_JOIN}{disposition}"
    if len(composed) > COMMENT_MAX:
        # The dismissal carries comment AND disposition, so the pair is what
        # has to fit; checking only the comment ships a truncated URL.
        raise Refusal(
            f"{where} composed dismissal comment is {len(composed)} characters, over {COMMENT_MAX}"
        )

    path = raw["path"]
    glob = compile_glob(path, f"{where} field path")
    matched = [candidate for candidate in tracked if glob.fullmatch(candidate)]
    if not matched:
        raise Refusal(f"{where} field path matches no tracked file: {path!r}")
    if within == "test-module":
        stray = [candidate for candidate in matched if not candidate.endswith(".rs")]
        if stray:
            raise Refusal(f"{where} scopes `within: test-module` over a non-Rust file: {stray[0]}")
    if reason == "used in tests" and within != "test-module":
        stray = [candidate for candidate in matched if not _is_test_location(candidate)]
        if stray:
            raise Refusal(
                f"{where} dismisses product code as 'used in tests': "
                f"{stray[0]} is not a test location"
            )
    return Entry(
        index=index,
        rule=rule,
        path=path,
        glob=glob,
        line_contains=line_contains,
        within=within,
        reason=reason,
        comment=comment,
        disposition=disposition,
        matches=len(matched),
    )


def load_entries(document: object, tracked: list[str]) -> list[Entry]:
    """Every entry, validated, or the first refusal."""
    if not isinstance(document, list):
        raise Refusal("the disposition file must be a JSON array")
    if not document:
        raise Refusal("the disposition file is empty; delete it rather than shipping an empty gate")
    return [_entry(raw, index, tracked) for index, raw in enumerate(document)]


def _relative(path: str, where: str) -> str:
    if path.startswith("/") or any(part in {"", ".", ".."} for part in path.split("/")):
        raise Refusal(f"{where} names a path this tool will not read: {path!r}")
    return path


def _alert(raw: object, position: int, expected_ref: str) -> Alert:
    where = f"alert at position {position}"
    if not isinstance(raw, dict):
        raise Refusal(f"{where} is not an object")
    number = raw.get("number")
    if isinstance(number, bool) or not isinstance(number, int) or number <= 0:
        raise Refusal(f"{where} has no positive alert number")
    where = f"alert #{number}"
    if raw.get("state") != "open":
        raise Refusal(
            f"{where} is {raw.get('state')!r}; this decision is made over open alerts only"
        )
    rule = _object(raw.get("rule"), f"{where} rule").get("id")
    if not isinstance(rule, str) or not rule or rule.split() != [rule]:
        raise Refusal(f"{where} has no readable rule id")
    instance = _object(raw.get("most_recent_instance"), f"{where} most recent instance")
    ref = instance.get("ref")
    if not isinstance(ref, str) or not ref:
        raise Refusal(f"{where} names no analysed ref")
    if ref != expected_ref:
        raise Refusal(f"{where} was analysed on {ref}, not {expected_ref}")
    location = _object(instance.get("location"), f"{where} location")
    path = location.get("path")
    if not isinstance(path, str) or not path:
        raise Refusal(f"{where} names no flagged path")
    line = location.get("start_line")
    if isinstance(line, bool) or not isinstance(line, int) or line <= 0:
        raise Refusal(f"{where} has no positive start line")
    return Alert(number=number, rule=rule, path=_relative(path, where), line=line, ref=ref)


def load_alerts(document: object, expected_ref: str) -> list[Alert]:
    if not isinstance(document, list):
        raise Refusal("the alert listing must be a JSON array")
    return [_alert(raw, position, expected_ref) for position, raw in enumerate(document)]


class Tree:
    """The checked-out tree an alert's flagged line is read from, and only that."""

    def __init__(self, root: Path) -> None:
        self.root = root.resolve()
        self._cache: dict[str, list[str] | None] = {}

    def lines(self, path: str) -> list[str] | None:
        if path not in self._cache:
            self._cache[path] = self._read(path)
        return self._cache[path]

    def _read(self, path: str) -> list[str] | None:
        try:
            resolved = (self.root / path).resolve()
        except OSError:
            return None
        # A tracked symlink out of the tree is not a place this tool reads
        # from: the flagged line must come from the analysed checkout.
        if resolved != self.root and self.root not in resolved.parents:
            return None
        try:
            return resolved.read_text(encoding="utf-8", errors="replace").splitlines()
        except OSError:
            return None


def _next_content_line(lines: list[str], after: int) -> int | None:
    for number in range(after + 1, len(lines) + 1):
        if lines[number - 1].strip():
            return number
    return None


def _closing_brace(lines: list[str], opened: int) -> int | None:
    """The first top-level `}` after `opened`, in a file `cargo fmt` accepts."""
    for number in range(opened + 1, len(lines) + 1):
        if lines[number - 1].rstrip() == "}":
            return number
    return None


def _only_trailing_comments(lines: list[str], after: int) -> bool:
    return all(not line.strip() or line.strip().startswith("//") for line in lines[after:])


def test_module_line(lines: list[str]) -> int | None:
    """The 1-based line where the file's `#[cfg(test)]` MODULE opens.

    NOT "the first `#[cfg(test)]` in the file". This codebase puts that
    attribute on early items -- a fake clock at `api/auth.rs:59`, a helper
    `fn dev` in `api/pairing.rs`, a fault enum and two `impl Store` blocks in
    `storage/mod.rs` -- so a first-marker rule would declare everything below
    line 59 of auth.rs "inside the test module" and a hard-coded value in
    PRODUCT code at line 400 would be dismissible as a test vector. That is the
    scope silently covering the thing it exists to exclude.

    So the scope opens only where the test tail actually begins: a `#[cfg(test)]`
    at top level whose next non-blank line is a top-level `mod ...`, and only
    when that module is the LAST top-level item in the file -- after its closing
    brace (or its `;`) nothing but blank lines and comments follow. An attribute
    on any other item opens nothing, a `mod` that is not last opens nothing, and
    a file with no qualifying module has no test tail at all. Every rejection
    leaves alerts UNCOVERED, so the failure direction is a red gate.
    """
    for number, line in enumerate(lines, start=1):
        if line.rstrip() != TEST_MODULE_MARKER:
            continue
        following = _next_content_line(lines, number)
        if following is None:
            continue
        declaration = lines[following - 1].rstrip()
        if not declaration.startswith("mod "):
            continue
        if declaration.endswith(";"):
            end: int | None = following
        elif declaration.endswith("{"):
            end = _closing_brace(lines, following)
        else:
            end = None
        if end is not None and _only_trailing_comments(lines, end):
            return number
    return None


def covers(entry: Entry, alert: Alert, tree: Tree) -> bool:
    """Whether this entry covers this alert, reading the flagged line if scoped."""
    if entry.rule != alert.rule or not entry.glob.fullmatch(alert.path):
        return False
    if entry.line_contains is None and entry.within is None:
        return True
    lines = tree.lines(alert.path)
    if lines is None or alert.line > len(lines):
        return False
    if entry.line_contains is not None:
        return entry.line_contains in lines[alert.line - 1]
    if not alert.path.endswith(".rs"):
        return False
    marker = test_module_line(lines)
    return marker is not None and alert.line >= marker


def classify(
    entries: list[Entry], alerts: list[Alert], tree: Tree
) -> list[tuple[Alert, Entry | None]]:
    """Each alert with the FIRST entry that covers it, or None."""
    return [
        (alert, next((entry for entry in entries if covers(entry, alert, tree)), None))
        for alert in alerts
    ]


def _read_json(path: Path) -> object:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as error:
        raise Refusal(f"{path} is not readable JSON: {error}") from error


def _read_tracked(path: Path) -> list[str]:
    tracked = [line for line in path.read_text(encoding="utf-8").splitlines() if line]
    if not tracked:
        raise Refusal(f"{path} lists no tracked file")
    return tracked


def _validate(args: argparse.Namespace) -> int:
    tracked = _read_tracked(args.tracked)
    entries = load_entries(_read_json(args.dispositions), tracked)
    for entry in entries:
        print(
            f"entry={entry.index} rule={entry.rule} path={entry.path} "
            f"scope={entry.scope()} reason={entry.reason!r} tracked_matches={entry.matches}"
        )
    print(
        f"codeql-dispositions: SUMMARY command=validate entries={len(entries)} "
        f"tracked={len(tracked)} decision=valid"
    )
    return 0


def _check(args: argparse.Namespace) -> int:
    tracked = _read_tracked(args.tracked)
    entries = load_entries(_read_json(args.dispositions), tracked)
    alerts = load_alerts(_read_json(args.alerts), args.ref)
    verdicts = classify(entries, alerts, Tree(args.tree))
    used: set[int] = set()
    uncovered = 0
    for alert, entry in verdicts:
        if entry is None:
            uncovered += 1
            print(f"uncovered {alert}")
            continue
        used.add(entry.index)
        print(f"covered {alert} entry={entry.index}")
    for entry in entries:
        if entry.index not in used:
            print(f"stale entry={entry.index} rule={entry.rule} path={entry.path}")
    decision = "refuse" if uncovered else "pass"
    print(
        f"codeql-dispositions: SUMMARY command=check ref={args.ref} alerts={len(alerts)} "
        f"covered={len(alerts) - uncovered} uncovered={uncovered} "
        f"stale={len(entries) - len(used)} decision={decision}"
    )
    if uncovered:
        print(
            f"codeql-dispositions: {uncovered} open alert(s) no reviewed disposition covers; "
            "fix the finding or add an entry to security/codeql-dispositions.json",
            file=sys.stderr,
        )
        return 1
    return 0


def _plan(args: argparse.Namespace) -> int:
    tracked = _read_tracked(args.tracked)
    entries = load_entries(_read_json(args.dispositions), tracked)
    alerts = load_alerts(_read_json(args.alerts), MAIN_REF)
    for alert, entry in classify(entries, alerts, Tree(args.tree)):
        if entry is None:
            continue
        print(
            json.dumps(
                {
                    "number": alert.number,
                    "reason": entry.reason,
                    "comment": entry.comment,
                    "disposition": entry.disposition,
                }
            )
        )
    return 0


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0] if __doc__ else None)
    commands = parser.add_subparsers(dest="command", required=True)

    validate = commands.add_parser("validate", help="the disposition file alone")
    validate.add_argument("--dispositions", type=Path, required=True)
    validate.add_argument("--tracked", type=Path, required=True)

    check = commands.add_parser("check", help="refuse any open alert no entry covers")
    check.add_argument("--dispositions", type=Path, required=True)
    check.add_argument("--alerts", type=Path, required=True)
    check.add_argument("--tree", type=Path, required=True)
    check.add_argument("--tracked", type=Path, required=True)
    check.add_argument("--ref", required=True)

    plan = commands.add_parser("plan", help="what main dismisses, one JSON object per line")
    plan.add_argument("--dispositions", type=Path, required=True)
    plan.add_argument("--alerts", type=Path, required=True)
    plan.add_argument("--tree", type=Path, required=True)
    plan.add_argument("--tracked", type=Path, required=True)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    commands = {"validate": _validate, "check": _check, "plan": _plan}
    try:
        return commands[args.command](args)
    except (Refusal, OSError, ValueError) as error:
        print(f"codeql-dispositions: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
