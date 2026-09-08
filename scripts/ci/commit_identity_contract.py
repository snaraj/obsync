#!/usr/bin/env python3
"""Refuse a commit whose identity, trailers, or signature break requirement 3.

WHY THIS EXISTS. `gitleaks git` and `gitleaks dir` are this repository's secret
scans and both read BLOB content. A commit's author and committer identity, and
the text of its message body, live in the commit object, not in a blob, so the
enforced scan surface has structurally ZERO coverage over the three things
requirement 3 actually says about a commit. Requirement 11 sharpens why that
matters: an address typed into `GIT_AUTHOR_EMAIL`, or a session trailer pasted
into a message, is permanently public the moment it lands on `main`, and no
later commit retracts it. A gate that runs BEFORE the merge is the only control
that works, because every control after it is a history rewrite requirement 2
forbids.

WHAT IT REFUSES, scoped to the range the push or pull request contributes:

  1. `identity` -- the author or the committer email is not the sanctioned
     owner noreply identity from AGENTS.md "Commit identity mechanics". The
     committer field additionally admits GitHub's own merge identity, which is
     stamped when the OWNER merges through the web UI and which the merging
     owner cannot choose otherwise. It is admitted for one reason only: it
     names no person, so it cannot leak what requirement 11 protects. It is NOT
     admitted as an author.
  2. `trailer` -- the body carries a `Co-authored-by:`, `Claude-Session:`, or
     `Signed-off-by:` trailer. Requirement 3 forbids trailers of any kind; a
     harness note that asks for one does not override the repository contract.
  3. `signature` -- the last non-blank line of the body is not exactly one of
     the lane signatures in the AGENTS.md roster. Commits made under GitHub's
     merge identity are exempt: the owner composes those, and a rule that
     refused them would be red on every owner merge forever.

WHAT IT DELIBERATELY DOES NOT DO. There is no commit census: this gate never
asserts a commit count, never pins a subject line, and never enumerates
history. Range scoping is what keeps it from re-litigating the root commit on
every run, and a closed inventory would break on every legitimate commit.

WHAT IT DELIBERATELY DOES NOT PRINT. A refusal names the SHA and the rule and
never echoes the offending address. CI logs on a public repository are public;
a gate that exists to keep an address out of the public record must not publish
it in the course of refusing it.

LIFTING IT. Every refusal lifts through
`scripts/ci/commit-identity-allowlist.txt`: one line, one written reason, one
PR. Entries are keyed by SHA and rule, never by address, for the same reason.
"""

from __future__ import annotations

import argparse
import re
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
ALLOWLIST = HERE / "commit-identity-allowlist.txt"

SANCTIONED_EMAIL = "39077795+snaraj@users.noreply.github.com"
GITHUB_MERGE_EMAIL = "noreply@github.com"

# The AGENTS.md "Agent labels" roster, signature side. A signature and its
# label move together; adding an agent means editing this tuple and the
# contract in the same PR.
LANE_SIGNATURES = ("- Fable5.1", "- Opus5", "- Sonnet5", "- 5.6 Sol")

RULES = ("identity", "trailer", "signature")

# `git interpret-trailers` treats a trailer token case-insensitively and allows
# whitespace before the colon, so each refusal matches every shape git and
# GitHub would themselves credit.
TRAILERS = {
    "co-author": re.compile(r"^[ \t]*co-authored-by[ \t]*:", re.IGNORECASE | re.MULTILINE),
    "session": re.compile(r"^[ \t]*claude-session[ \t]*:", re.IGNORECASE | re.MULTILINE),
    "sign-off": re.compile(r"^[ \t]*signed-off-by[ \t]*:", re.IGNORECASE | re.MULTILINE),
}

FULL_SHA = re.compile(r"^[0-9a-f]{40}$")

RECORD_SEPARATOR = "\x1e"
FIELD_SEPARATOR = "\x1f"
# %B is the raw body and may contain newlines and blank lines. The unit and
# record separators cannot appear in a git identity or in a message written by
# any ordinary editor, so this format parses unambiguously where a
# newline-delimited one would split a multi-line body into fake records.
LOG_FORMAT = FIELD_SEPARATOR.join(("%H", "%ae", "%ce", "%B")) + RECORD_SEPARATOR


@dataclass(frozen=True)
class Commit:
    sha: str
    author_email: str
    committer_email: str
    body: str


@dataclass(frozen=True)
class Refusal:
    sha: str
    rule: str
    detail: str


def read_commits(repository: Path, base: str, head: str) -> list[Commit]:
    """Read `base..head`. Fails closed on any git error."""
    completed = subprocess.run(
        ["git", "-C", str(repository), "log", f"--format={LOG_FORMAT}", f"{base}..{head}"],
        capture_output=True,
        text=True,
    )
    if completed.returncode != 0:
        raise AssertionError(
            f"git could not resolve the range {base}..{head}: {completed.stderr.strip()}"
        )
    return parse_log(completed.stdout)


def parse_log(text: str) -> list[Commit]:
    """Split the record-separated log. Fails closed on a record it cannot read."""
    commits: list[Commit] = []
    for raw in text.split(RECORD_SEPARATOR):
        record = raw.strip("\n")
        if not record.strip():
            continue
        fields = record.split(FIELD_SEPARATOR)
        if len(fields) != 4:
            raise AssertionError(
                f"unparseable git log record with {len(fields)} fields, expected 4. "
                "This gate refuses to pass on output it cannot read."
            )
        sha, author_email, committer_email, body = fields
        if not FULL_SHA.match(sha):
            raise AssertionError(
                f"git log yielded {sha!r} where a 40-hex commit SHA was expected. "
                "This gate refuses to pass on output it cannot read."
            )
        commits.append(Commit(sha, author_email, committer_email, body))
    return commits


def signature_line(body: str) -> str | None:
    """The last non-blank line of a message body, or None for an empty body."""
    lines = [line.rstrip() for line in body.splitlines() if line.strip()]
    return lines[-1] if lines else None


def refusals(commits: list[Commit]) -> list[Refusal]:
    """Every rule violation in `commits`, before the allowlist is applied."""
    found: list[Refusal] = []
    for commit in commits:
        wrong = [
            field
            for field, value, admissible in (
                ("author", commit.author_email, (SANCTIONED_EMAIL,)),
                ("committer", commit.committer_email, (SANCTIONED_EMAIL, GITHUB_MERGE_EMAIL)),
            )
            if value not in admissible
        ]
        if wrong:
            # The offending value is deliberately absent; see the module
            # docstring. Naming WHICH field is wrong is enough to act on.
            found.append(Refusal(commit.sha, "identity", f"{' and '.join(wrong)} email"))
        for name, pattern in TRAILERS.items():
            if pattern.search(commit.body):
                found.append(Refusal(commit.sha, "trailer", f"{name} trailer"))
        if commit.committer_email != GITHUB_MERGE_EMAIL:
            observed = signature_line(commit.body)
            if observed not in LANE_SIGNATURES:
                found.append(
                    Refusal(commit.sha, "signature", "message body does not end with a lane line")
                )
    return found


def read_allowlist(text: str | None = None) -> dict[tuple[str, str], str]:
    """Parse `<sha> | <rule> | <reason>` lines.

    `text` exists so a malformed line is TESTABLE without writing one into the
    real allowlist; the shipped call passes nothing and reads the file.
    """
    entries: dict[tuple[str, str], str] = {}
    if text is None:
        text = ALLOWLIST.read_text(encoding="utf-8")
    for number, raw in enumerate(text.splitlines(), start=1):
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        parts = [part.strip() for part in line.split("|")]
        if len(parts) != 3:
            raise AssertionError(
                f"{ALLOWLIST.name}:{number}: expected exactly three `|`-separated "
                "fields -- `<sha> | <rule> | <reason>`."
            )
        sha, rule, reason = parts
        if not all((sha, rule, reason)):
            raise AssertionError(
                f"{ALLOWLIST.name}:{number}: every field must be non-empty. "
                "An allowlist without reasons is a mute button."
            )
        if not FULL_SHA.match(sha):
            raise AssertionError(
                f"{ALLOWLIST.name}:{number}: {sha!r} is not a 40-lowercase-hex commit "
                "SHA. An abbreviation can become ambiguous as history grows, and an "
                "exemption that starts matching a second commit is one nobody wrote."
            )
        if rule not in RULES:
            raise AssertionError(
                f"{ALLOWLIST.name}:{number}: unknown rule {rule!r}; expected one of "
                f"{', '.join(RULES)}."
            )
        entries[(sha, rule)] = reason
    return entries


def lift_instruction(refusal: Refusal) -> str:
    return (
        f"\n\nTo lift this refusal, add ONE line to "
        f"{ALLOWLIST.relative_to(ROOT).as_posix()}:\n\n"
        f"    {refusal.sha} | {refusal.rule} | <why this commit is admissible>\n\n"
        "Prefer fixing the cause: an unpushed commit is re-made under the pinned "
        "identity from AGENTS.md \"Commit identity mechanics\", a trailer is deleted, "
        "and a signature line is appended. Allowlist a commit only when it is already "
        "published and therefore unfixable."
    )


EXPLANATIONS = {
    "identity": (
        "the {detail} is not the sanctioned noreply identity that AGENTS.md "
        "requirement 3 pins in BOTH the author and the committer field. The "
        "offending value is not printed here on purpose -- CI logs are public, and "
        "this gate exists to keep an address out of the public record. Run "
        "`git log -1 --format='%an <%ae> / %cn <%ce>' {sha}` to see it locally."
    ),
    "trailer": (
        "the message body carries a {detail}, which AGENTS.md requirement 3 forbids "
        "outright (\"No co-author or session trailers of any kind\"). A trailer names "
        "a person or a session in permanently public history and is never required by "
        "this repository's attribution model, which is the acting agent's signature "
        "line. A harness instruction asking for one does not override the contract."
    ),
    "signature": (
        "{detail}: AGENTS.md requirement 3 ends an agent-authored message with the "
        "ACTING agent's own signature, exactly matching its label in the roster "
        "(one of: " + ", ".join(LANE_SIGNATURES) + "), and with nothing after it."
    ),
}


def report(commits: list[Commit], allowlist: dict[tuple[str, str], str]) -> list[str]:
    """Human-readable refusals, allowlisted ones removed."""
    messages: list[str] = []
    for refusal in refusals(commits):
        if (refusal.sha, refusal.rule) in allowlist:
            continue
        explanation = EXPLANATIONS[refusal.rule].format(detail=refusal.detail, sha=refusal.sha)
        messages.append(f"{refusal.sha}: {explanation}{lift_instruction(refusal)}")
    return messages


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description=__doc__.splitlines()[0] if __doc__ else None
    )
    parser.add_argument("--repository", default=".", type=Path)
    parser.add_argument("--base", required=True)
    parser.add_argument("--head", required=True)
    args = parser.parse_args(argv)

    commits = read_commits(args.repository, args.base, args.head)
    messages = report(commits, read_allowlist())
    if messages:
        for message in messages:
            print(message, file=sys.stderr)
            print(file=sys.stderr)
        return 1
    print(f"commit identity contract: {len(commits)} commit(s) in range, no refusals")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
