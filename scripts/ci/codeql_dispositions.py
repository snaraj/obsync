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
and the issue that holds the reasoning. This module decides four things about
that file, offline, and the workflow does every piece of I/O:

  validate   the file is well formed, every glob names a place that exists, no
             entry dismisses product code as `used in tests`, and every
             acceptance over product code names what was reviewed;
  check      every alert in the listing is covered by some entry -- an
             uncovered alert exits 1 and is named, which is what turns a new
             real finding into a red gate rather than a click;
  reconcile  what main's DISMISSED alerts need for this file to be their
             authority: reopen what nothing covers, rewrite a stored
             justification that is not this file's;
  plan       what `main` will dismiss, one JSON object per covered alert.

WHY DISMISSED ALERTS ARE READ TOO. A dismissal is permanent until someone
changes it. An entry removed, an entry narrowed, or a dismissal typed into the
UI is invisible to an open-only listing forever, so the file would stop being
the authority for exactly the findings that are already quiet. `reconcile`
reopens what nothing covers -- the one mutation that makes the state MORE
visible -- and the base check counts a dismissed alert nothing covers as a
failure, because the next push to main would reopen it.

WHY THE PARSING IS CLOSED. The disposition file is the authority for silencing
a security tool, so an unknown key, a wrong type, a wildcard rule id, a glob
with no literal segment, or a comment that would arrive truncated is a refusal
that names the field -- never a default and never a shrug. The alert listing
comes from an API and is read with the same suspicion: a state the caller did
not ask for, a ref that is not the one it asked about, a commit that is not the
one being judged, or an analysis key from another workflow is a refusal rather
than something quietly skipped, because each means the caller is judging a
listing it did not ask for -- or reading line numbers out of a checkout that
never produced them. A flagged path is read only from inside the tree it was
given.

WHY THE SCOPES ARE NARROW. `line_contains` pins a disposition to the source
line CodeQL actually flagged, so an entry over `storage/mod.rs` stops covering
anything the moment the salt constant it names moves away from the alert.
`within: test-module` covers a Rust file's TRAILING `#[cfg(test)] mod` and
nothing above it -- never merely the first `#[cfg(test)]`, which in this
codebase sits on a fake clock at `api/auth.rs:59` -- so a test vector is
dismissible and the same rule firing on product code in the same file is not.
`used in tests` is refused outright over product code: the reason has to be
true.

WHY PRODUCT ACCEPTANCES BIND TO CONTENT. A token scope accepts whatever a later
edit puts on a line carrying that token, so an acceptance over shipped code must
name what was actually read: `line_is`, the exact line, compared after trimming
and never as a substring; or `reviewed_sha256`, the bytes of one tracked file,
re-verified on every run whether or not an alert touches it. That is how an edit
to accepted code cannot land without re-triage in the same pull request.

Standard library only (requirement 5); no network, no environment reads, no
clock. Refusals are `Refusal` exceptions carrying one sentence.
"""

from __future__ import annotations

import argparse
import hashlib
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
# WHERE the entry applies: at most one, because two location predicates would
# be two claims about the same line with no rule for disagreement.
LOCATION_FIELDS = ("line_contains", "line_is", "within")
# WHAT was reviewed: the bytes of the file the acceptance was written against.
CONTENT_FIELDS = ("reviewed_sha256",)
OPTIONAL_FIELDS = LOCATION_FIELDS + CONTENT_FIELDS
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
ALERT_STATES = ("open", "dismissed")
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
    line_is: str | None
    within: str | None
    reviewed_sha256: str | None
    reason: str
    comment: str
    disposition: str
    matches: int

    @property
    def dismissal_comment(self) -> str:
        return f"{self.comment}{DISPOSITION_JOIN}{self.disposition}"

    def scope(self) -> str:
        parts = []
        if self.line_contains is not None:
            parts.append(f"line_contains={self.line_contains}")
        if self.line_is is not None:
            parts.append(f"line_is={self.line_is}")
        if self.within is not None:
            parts.append(f"within={self.within}")
        if self.reviewed_sha256 is not None:
            parts.append(f"reviewed_sha256={self.reviewed_sha256[:12]}")
        return ",".join(parts) if parts else "path"


@dataclass(frozen=True)
class Alert:
    """The facts a disposition decision needs about one alert."""

    number: int
    state: str
    instance_state: str | None
    rule: str
    path: str
    line: int
    ref: str
    commit_sha: str
    analysis_key: str
    dismissed_reason: str | None
    dismissed_comment: str | None

    @property
    def historical(self) -> bool:
        """The finding is no longer detected; this instance is a record, not a place.

        GitHub keeps a dismissed alert dismissed after the code that produced it
        is gone, and leaves `most_recent_instance` on the last analysis that saw
        it. Such an instance names an old commit BY CONSTRUCTION, so binding it
        to today's commit would refuse it forever, and judging its line number
        against today's tree would read an unrelated line. It is skipped,
        counted and named -- never reopened, never re-dismissed, never dismissed.
        """
        return self.instance_state == "fixed"

    def __str__(self) -> str:
        return f"#{self.number} {self.rule} {self.path}:{self.line} state={self.state}"


def _entry(raw: object, index: int, tracked: list[str]) -> Entry:
    where = f"entry {index}"
    if not isinstance(raw, dict):
        raise Refusal(f"{where} is not an object")
    unknown = sorted(set(raw) - set(REQUIRED_FIELDS) - set(OPTIONAL_FIELDS))
    if unknown:
        raise Refusal(f"{where} has unknown field(s): {', '.join(unknown)}")
    for field in REQUIRED_FIELDS:
        if field not in raw:
            raise Refusal(f"{where} is missing field {field}")
    for field in REQUIRED_FIELDS + OPTIONAL_FIELDS:
        if field in raw and not isinstance(raw[field], str):
            raise Refusal(f"{where} field {field} is not a string")

    rule = raw["rule"]
    if not RULE_RE.match(rule):
        raise Refusal(f"{where} field rule is not one exact CodeQL rule id: {rule!r}")

    present = [field for field in LOCATION_FIELDS if field in raw]
    if len(present) > 1:
        raise Refusal(f"{where} carries {' and '.join(present)}; an entry has at most one scope")
    line_contains = raw.get("line_contains")
    if line_contains is not None and len(line_contains) < MIN_TOKEN:
        raise Refusal(f"{where} field line_contains must be at least {MIN_TOKEN} characters")
    if line_contains is not None and line_contains.strip() != line_contains:
        raise Refusal(f"{where} field line_contains is not a trimmed token")
    line_is = raw.get("line_is")
    if line_is is not None and (not line_is.strip() or "\n" in line_is or "\r" in line_is):
        raise Refusal(f"{where} field line_is is not one non-empty source line")
    within = raw.get("within")
    if within is not None and within not in WITHIN_VALUES:
        raise Refusal(f"{where} field within must be one of {', '.join(WITHIN_VALUES)}")
    reviewed = raw.get("reviewed_sha256")
    if reviewed is not None and not SHA256_RE.match(reviewed):
        raise Refusal(f"{where} field reviewed_sha256 is not a lowercase hex sha256")

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
    product = [candidate for candidate in matched if not _is_test_location(candidate)]
    if reason == "used in tests" and within != "test-module":
        if product:
            raise Refusal(
                f"{where} dismisses product code as 'used in tests': "
                f"{product[0]} is not a test location"
            )
    if reviewed is not None:
        # A content hash names ONE file's bytes, so the path may not be a glob:
        # a hash over "whichever file matched" is a hash over nothing.
        if "*" in path or len(matched) != 1:
            raise Refusal(
                f"{where} carries reviewed_sha256 but its path is not one tracked file: {path!r}"
            )
    if within != "test-module" and product and line_is is None and reviewed is None:
        # THE PRODUCT-CODE RULE. An acceptance over shipped code has to name
        # what was actually read: the exact line, or the bytes of the file. A
        # `line_contains` token alone accepts whatever a later edit puts on a
        # line carrying that token -- which is how a real finding inherits a
        # false-positive verdict nobody re-read.
        raise Refusal(
            f"{where} accepts product code ({product[0]}) without naming what was reviewed; "
            "add line_is or reviewed_sha256"
        )
    return Entry(
        index=index,
        rule=rule,
        path=path,
        glob=glob,
        line_contains=line_contains,
        line_is=line_is,
        within=within,
        reviewed_sha256=reviewed,
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


def _alert(
    raw: object,
    position: int,
    expected_ref: str,
    expected_commit: str,
    expected_key: str,
    states: tuple[str, ...],
) -> Alert:
    where = f"alert at position {position}"
    if not isinstance(raw, dict):
        raise Refusal(f"{where} is not an object")
    number = raw.get("number")
    if isinstance(number, bool) or not isinstance(number, int) or number <= 0:
        raise Refusal(f"{where} has no positive alert number")
    where = f"alert #{number}"
    state = raw.get("state")
    if state not in states:
        raise Refusal(
            f"{where} is {state!r}; this listing was asked for {', '.join(states)}"
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
    instance_state = instance.get("state")
    if instance_state is not None and not isinstance(instance_state, str):
        raise Refusal(f"{where} instance state is neither a string nor null")
    # The record has to name the SOURCE it describes and the analysis that
    # produced it. Without both, a line number is read out of a checkout that
    # may not be the one the finding was found in, and an alert from another
    # workflow's analysis is judged by a policy that never covered it. The one
    # exemption is an instance the tool itself calls `fixed`: nothing is judged
    # from it at all, so there is nothing to bind.
    commit = instance.get("commit_sha")
    if not isinstance(commit, str) or not commit:
        raise Refusal(f"{where} names no analysed commit")
    key = instance.get("analysis_key")
    if not isinstance(key, str) or not key:
        raise Refusal(f"{where} names no analysis key")
    if instance_state != "fixed":
        if commit != expected_commit:
            raise Refusal(
                f"{where} was analysed on commit {commit}, not {expected_commit}; "
                "superseded or foreign; refusing to judge on stale locations"
            )
        if key != expected_key:
            raise Refusal(
                f"{where} came from analysis {key}, not {expected_key}; "
                "superseded or foreign; refusing to judge on stale locations"
            )
    location = _object(instance.get("location"), f"{where} location")
    path = location.get("path")
    if not isinstance(path, str) or not path:
        raise Refusal(f"{where} names no flagged path")
    line = location.get("start_line")
    if isinstance(line, bool) or not isinstance(line, int) or line <= 0:
        raise Refusal(f"{where} has no positive start line")
    dismissed_reason = raw.get("dismissed_reason")
    dismissed_comment = raw.get("dismissed_comment")
    for field, value in (("dismissed_reason", dismissed_reason), ("dismissed_comment", dismissed_comment)):
        if value is not None and not isinstance(value, str):
            raise Refusal(f"{where} field {field} is neither a string nor null")
    return Alert(
        number=number,
        state=state,
        instance_state=instance_state,
        rule=rule,
        path=_relative(path, where),
        line=line,
        ref=ref,
        commit_sha=commit,
        analysis_key=key,
        dismissed_reason=dismissed_reason,
        dismissed_comment=dismissed_comment,
    )


def load_alerts(
    document: object,
    expected_ref: str,
    expected_commit: str,
    expected_key: str,
    states: tuple[str, ...] = ("open",),
) -> list[Alert]:
    if not isinstance(document, list):
        raise Refusal("the alert listing must be a JSON array")
    return [
        _alert(raw, position, expected_ref, expected_commit, expected_key, states)
        for position, raw in enumerate(document)
    ]


class Tree:
    """The checked-out tree an alert's flagged line is read from, and only that."""

    def __init__(self, root: Path) -> None:
        self.root = root.resolve()
        self._cache: dict[str, list[str] | None] = {}

    def lines(self, path: str) -> list[str] | None:
        if path not in self._cache:
            content = self.blob(path)
            self._cache[path] = (
                None if content is None else content.decode("utf-8", "replace").splitlines()
            )
        return self._cache[path]

    def blob(self, path: str) -> bytes | None:
        """The file's exact bytes, or None if it is not a file inside this tree."""
        try:
            resolved = (self.root / path).resolve()
        except OSError:
            return None
        # A tracked symlink out of the tree is not a place this tool reads
        # from: the flagged line must come from the analysed checkout.
        if resolved != self.root and self.root not in resolved.parents:
            return None
        try:
            return resolved.read_bytes()
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
    if entry.line_contains is None and entry.line_is is None and entry.within is None:
        return True
    lines = tree.lines(alert.path)
    if lines is None or alert.line > len(lines):
        return False
    if entry.line_is is not None:
        # Equality after trimming, never a substring: the entry names the line
        # that was read, so a line that merely contains it is a different line.
        return lines[alert.line - 1].strip() == entry.line_is.strip()
    if entry.line_contains is not None:
        return entry.line_contains in lines[alert.line - 1]
    if not alert.path.endswith(".rs"):
        return False
    marker = test_module_line(lines)
    return marker is not None and alert.line >= marker


def verify_reviewed_content(entries: list[Entry], tree: Tree) -> None:
    """Every `reviewed_sha256` still describes the file it was written against.

    Checked on EVERY run, whether or not an alert touches the file. That is the
    whole guard: an edit to a reviewed printer cannot land without the same pull
    request re-reading it and moving the hash, because the hash is what says
    somebody looked.
    """
    for entry in entries:
        if entry.reviewed_sha256 is None:
            continue
        content = tree.blob(entry.path)
        if content is None:
            raise Refusal(
                f"entry {entry.index}: {entry.path} is not readable in the tree being judged; "
                f"re-triage {entry.disposition} and update reviewed_sha256"
            )
        actual = hashlib.sha256(content).hexdigest()
        if actual != entry.reviewed_sha256:
            raise Refusal(
                f"entry {entry.index}: {entry.path} differs from the reviewed content "
                f"(sha256 {actual}); re-triage {entry.disposition} and update reviewed_sha256"
            )


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


def _states(raw: str) -> tuple[str, ...]:
    parts = tuple(part.strip() for part in raw.split(","))
    if any(part not in ALERT_STATES for part in parts) or len(set(parts)) != len(parts):
        raise Refusal(
            f"--states must be a comma-separated subset of {', '.join(ALERT_STATES)}: {raw!r}"
        )
    return parts


def _prepared(args: argparse.Namespace, states: tuple[str, ...], ref: str, listing: Path):
    """Entries validated, reviewed content verified, alerts closed-parsed."""
    tracked = _read_tracked(args.tracked)
    entries = load_entries(_read_json(args.dispositions), tracked)
    verify_reviewed_content(entries, Tree(args.content_tree))
    alerts = load_alerts(_read_json(listing), ref, args.commit, args.analysis_key, states)
    return entries, alerts


def _live(alerts: list[Alert]) -> tuple[list[Alert], list[Alert]]:
    """The alerts to judge, and the ones whose instance is no longer detected."""
    return (
        [alert for alert in alerts if not alert.historical],
        [alert for alert in alerts if alert.historical],
    )


def _check(args: argparse.Namespace) -> int:
    states = _states(args.states)
    entries, listed = _prepared(args, states, args.ref, args.alerts)
    alerts, historical = _live(listed)
    for alert in historical:
        print(f"stale {alert} instance=fixed")
    verdicts = classify(entries, alerts, Tree(args.tree))
    used: set[int] = set()
    uncovered = 0
    drifted = 0
    for alert, entry in verdicts:
        if entry is None:
            uncovered += 1
            note = (
                " (dismissed; the next push to main would reopen it)"
                if alert.state == "dismissed"
                else ""
            )
            print(f"uncovered {alert}{note}")
            continue
        used.add(entry.index)
        print(f"covered {alert} entry={entry.index}")
        if alert.state == "dismissed" and (
            alert.dismissed_reason != entry.reason
            or alert.dismissed_comment != entry.dismissal_comment
        ):
            # Informational on a check: the push run repairs the record. Saying
            # it here is how a reviewer sees that main's stored justification
            # is not the one this file carries.
            drifted += 1
            print(
                f"drift #{alert.number} entry={entry.index} "
                f"reason={alert.dismissed_reason!r} expected={entry.reason!r}"
            )
    for entry in entries:
        if entry.index not in used:
            print(f"stale entry={entry.index} rule={entry.rule} path={entry.path}")
    decision = "refuse" if uncovered else "pass"
    print(
        f"codeql-dispositions: SUMMARY command=check ref={args.ref} "
        f"alerts={len(alerts)} covered={len(alerts) - uncovered} uncovered={uncovered} "
        f"drift={drifted} stale_alerts={len(historical)} "
        f"stale={len(entries) - len(used)} decision={decision}"
    )
    if uncovered:
        print(
            f"codeql-dispositions: {uncovered} alert(s) no reviewed disposition covers; "
            "fix the finding or add an entry to security/codeql-dispositions.json",
            file=sys.stderr,
        )
        return 1
    return 0


def _reconcile(args: argparse.Namespace) -> int:
    """What main's DISMISSED alerts need for the file to be their authority.

    A dismissal is permanent until someone changes it, so an entry removed,
    narrowed, or never written leaves the finding silent forever and no later
    run would notice. Reopening is the one mutation that makes the state MORE
    visible: it turns that drift into the single failure `check` already has,
    an uncovered open alert on main.
    """
    entries, listed = _prepared(args, ("dismissed",), MAIN_REF, args.dismissed)
    alerts, historical = _live(listed)
    for alert in historical:
        print(json.dumps({"action": "stale", "number": alert.number}))
    for alert, entry in classify(entries, alerts, Tree(args.tree)):
        if entry is None:
            print(json.dumps({"action": "reopen", "number": alert.number}))
            continue
        if (
            alert.dismissed_reason != entry.reason
            or alert.dismissed_comment != entry.dismissal_comment
        ):
            print(
                json.dumps(
                    {
                        "action": "redismiss",
                        "number": alert.number,
                        "reason": entry.reason,
                        "comment": entry.comment,
                        "disposition": entry.disposition,
                    }
                )
            )
            continue
        print(json.dumps({"action": "unchanged", "number": alert.number}))
    return 0


def _plan(args: argparse.Namespace) -> int:
    entries, listed = _prepared(args, ("open",), MAIN_REF, args.alerts)
    alerts, _ = _live(listed)
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


def _judged(command: argparse.ArgumentParser) -> None:
    """The arguments every alert-judging command takes, all required.

    `--tree` is where a LOCATION predicate is read (the tree the finding was
    taken from); `--content-tree` is where `reviewed_sha256` is read (the
    content the decision will govern). On main they are the same directory; on
    a pull request judging the base branch they are not, and passing both
    explicitly is what keeps that distinction from being a default nobody sees.
    """
    command.add_argument("--dispositions", type=Path, required=True)
    command.add_argument("--tree", type=Path, required=True)
    command.add_argument("--content-tree", type=Path, required=True)
    command.add_argument("--tracked", type=Path, required=True)
    command.add_argument("--commit", required=True)
    command.add_argument("--analysis-key", required=True)


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0] if __doc__ else None)
    commands = parser.add_subparsers(dest="command", required=True)

    validate = commands.add_parser("validate", help="the disposition file alone")
    validate.add_argument("--dispositions", type=Path, required=True)
    validate.add_argument("--tracked", type=Path, required=True)

    check = commands.add_parser("check", help="refuse any alert no entry covers")
    _judged(check)
    check.add_argument("--alerts", type=Path, required=True)
    check.add_argument("--ref", required=True)
    check.add_argument("--states", required=True)

    reconcile = commands.add_parser(
        "reconcile", help="what main's dismissed alerts need, one JSON object per line"
    )
    _judged(reconcile)
    reconcile.add_argument("--dismissed", type=Path, required=True)

    plan = commands.add_parser("plan", help="what main dismisses, one JSON object per line")
    _judged(plan)
    plan.add_argument("--alerts", type=Path, required=True)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    commands = {
        "validate": _validate,
        "check": _check,
        "reconcile": _reconcile,
        "plan": _plan,
    }
    try:
        return commands[args.command](args)
    except (Refusal, OSError, ValueError) as error:
        print(f"codeql-dispositions: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
