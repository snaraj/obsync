#!/usr/bin/env python3
"""Fail-closed release identity, classification, and publication policy.

Requirement 10 and `docs/release.md`, made executable. Standard library only
(requirement 5): CI and the hostile suite in `test_release_contract.py` call
the same functions, so a release decision cannot drift into prose.

THE SEVEN LOCKSTEP LOCKS. `VERSION`, the workspace `version` in `Cargo.toml`,
`chart/Chart.yaml` `version` and `appVersion`, `chart/values.yaml` `image.tag`
(`vX.Y.Z`), `plugin/manifest.json` `version`, and the `CHANGELOG.md` `X.Y.Z`
heading. Six files, seven facts, one number.

THE CLASSIFIER HAS TWO VERDICTS AND NO FLAG. A range whose every commit is
confined to root `AGENTS.md`, `README.md`, `.gitignore`, and Markdown under
`docs/` is `no-artifact` and must advance nothing. Anything else is `artifact`
and must advance every lock exactly one patch from its protected base. A
non-allowlisted path with an unchanged version denies; there is no third path
and no environment variable that reaches one.
"""

from __future__ import annotations

import argparse
import copy
import datetime as dt
import hashlib
import json
import re
import subprocess
import sys
import tomllib
from dataclasses import dataclass
from pathlib import Path
from typing import Mapping

SEMVER_RE = re.compile(r"^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$")
SHA_RE = re.compile(r"^[0-9a-f]{40}$")
DIGEST_RE = re.compile(r"^sha256:([0-9a-f]{64})$")

EXPECTED_REPOSITORY = "snaraj/obsync"
EXPECTED_IMAGE = "ghcr.io/snaraj/obsync"
EXPECTED_CHART = "ghcr.io/snaraj/charts/obsync"

EXPECTED_WORKFLOW = "PR gate"
EXPECTED_WORKFLOW_PATH = ".github/workflows/pr-gate.yml"
EXPECTED_CODEQL_WORKFLOW = "CodeQL"
EXPECTED_CODEQL_WORKFLOW_PATH = ".github/workflows/codeql.yml"
EXPECTED_PUBLISHER_PATH = ".github/workflows/release-publisher.yml"

GITHUB_ACTIONS_BOT_LOGIN = "github-actions[bot]"
GITHUB_ACTIONS_BOT_ID = 41898282
GITHUB_ACTIONS_INTEGRATION_ID = 15368
GITHUB_API_VERSION = "2026-03-10"

# The closed inventory of a protected-main gate run, exact in both directions.
# obsync's gate has no pull-request-only job, so every entry is `success`: a
# `skipped` here would mean a job stopped running on main and nobody
# re-anchored the surface the publisher authorizes against.
EXPECTED_MAIN_JOBS = {
    "application": "success",
    "chart": "success",
    "gate": "success",
    "security": "success",
}
EXPECTED_CODEQL_JOBS = {
    "analyze (javascript-typescript, none)": "success",
    "analyze (rust, none)": "success",
}
REQUIRED_STATUS_CHECKS = (
    "analyze (javascript-typescript, none)",
    "analyze (rust, none)",
    "application",
    "chart",
    "gate",
    "security",
)

RELEASE_MANIFEST_SCHEMA = "https://github.com/snaraj/obsync/schemas/release-manifest/v1"
RELEASE_MANIFEST_WORKFLOW = EXPECTED_PUBLISHER_PATH
RELEASE_MANIFEST_PLATFORMS = ["linux/amd64", "linux/arm64"]
TRIVY_VERSION = "0.72.0"
TRIVY_SEVERITIES = ["HIGH", "CRITICAL"]

CHART_DIGEST_SENTINEL = "sha256:" + "0" * 64
CHART_DIGEST_LINE_RE = re.compile(r"^  digest: .*$", re.MULTILINE)

DOCUMENTATION_FILES = frozenset({"AGENTS.md", "README.md", ".gitignore"})
DOCUMENTATION_TREE = "docs/"
RELEASE_LOCK_PATHS = (
    "VERSION",
    "Cargo.toml",
    "chart/Chart.yaml",
    "chart/values.yaml",
    "plugin/manifest.json",
    "CHANGELOG.md",
)
_DIFF_MODES = frozenset({"000000", "100644", "100755"})
_DIFF_STATUSES = frozenset({"A", "D", "M"})


class ContractError(ValueError):
    """Every refusal in this module. Never caught to continue."""


# `order=True` so the changelog ladder can be compared directly; the field
# order below IS semver precedence.
@dataclass(frozen=True, order=True)
class Version:
    major: int
    minor: int
    patch: int

    @classmethod
    def parse(cls, raw: str) -> "Version":
        match = SEMVER_RE.fullmatch(raw.strip())
        if not match:
            raise ContractError(f"invalid semantic version: {raw!r}")
        return cls(*(int(part) for part in match.groups()))

    def __str__(self) -> str:
        return f"{self.major}.{self.minor}.{self.patch}"

    @property
    def tag(self) -> str:
        return f"v{self}"


@dataclass(frozen=True)
class ReleaseIntent:
    source_sha: str
    version: Version

    @property
    def tag(self) -> str:
        return self.version.tag


@dataclass(frozen=True)
class TransitionWindow:
    base_sha: str
    intent: ReleaseIntent


def require_sha(raw: object, field: str) -> str:
    if not isinstance(raw, str) or not SHA_RE.fullmatch(raw):
        raise ContractError(f"{field} must be one lowercase 40-hex commit SHA")
    return raw


def require_next_patch(base: Version, head: Version) -> None:
    expected = Version(base.major, base.minor, base.patch + 1)
    if head != expected:
        raise ContractError(f"head version {head} must be exact next patch {expected}")


def _object(value: object, field: str) -> Mapping[str, object]:
    if not isinstance(value, Mapping):
        raise ContractError(f"{field} must be a JSON object")
    return value


def _array(value: object, field: str) -> list[object]:
    if not isinstance(value, list):
        raise ContractError(f"{field} must be a JSON array")
    return value


def _top_level_scalar(text: str, key: str) -> str:
    """Read one unindented `key: value` from a small YAML document."""
    values = [
        line.split(":", 1)[1].strip().strip("\"'")
        for line in text.splitlines()
        if line == line.lstrip() and line.startswith(f"{key}:")
    ]
    if len(values) != 1 or not values[0]:
        raise ContractError(f"expected exactly one non-empty top-level {key!r} scalar")
    return values[0]


def _direct_child_scalar(text: str, parent: str, key: str) -> str:
    """Read one `  key: value` directly under an unindented `parent:` mapping."""
    lines = text.splitlines()
    parents = [index for index, line in enumerate(lines) if line.rstrip() == f"{parent}:"]
    if len(parents) != 1:
        raise ContractError(f"expected exactly one top-level {parent!r} mapping")
    values: list[str] = []
    for line in lines[parents[0] + 1 :]:
        if line and not line[0].isspace() and not line.lstrip().startswith("#"):
            break
        if line.startswith(f"  {key}:"):
            values.append(line.split(":", 1)[1].strip().strip("\"'"))
    if len(values) != 1 or not values[0]:
        raise ContractError(f"expected exactly one non-empty {parent}.{key} scalar")
    return values[0]


# --------------------------------------------------------------------------
# The seven locks
# --------------------------------------------------------------------------

_CHANGELOG_HEADING_RE = re.compile(r"^## (?P<version>\S+) - (?P<date>.+)$", re.MULTILINE)


def parse_changelog(text: str) -> list[tuple[Version, str]]:
    """Return every `## X.Y.Z - <date|Unreleased>` heading, in file order.

    The ladder is the released ledger. It is read whole rather than only at
    its top, because a snapshot that carries a perfectly well-formed current
    heading can still have had three older ones deleted underneath it.
    """
    headings: list[tuple[Version, str]] = []
    for match in _CHANGELOG_HEADING_RE.finditer(text):
        raw_version = match.group("version")
        if not SEMVER_RE.fullmatch(raw_version):
            raise ContractError(f"changelog heading {raw_version!r} is not a bare X.Y.Z version")
        stamp = match.group("date").strip()
        if stamp != "Unreleased":
            try:
                dt.date.fromisoformat(stamp)
            except ValueError as exc:
                raise ContractError(
                    f"changelog {raw_version} date {stamp!r} is neither an ISO date nor Unreleased"
                ) from exc
        headings.append((Version.parse(raw_version), stamp))
    if not headings:
        raise ContractError("changelog carries no `## X.Y.Z - <date>` heading")
    for (newer, _newer_stamp), (older, _older_stamp) in zip(headings, headings[1:]):
        if newer <= older:
            raise ContractError(
                f"changelog heading {newer} must be strictly newer than the {older} below it"
            )
    return headings


def require_appended_changelog(base_text: str, head_text: str) -> None:
    """Released history is append-only: every base heading survives at head."""
    base_headings = {version for version, _stamp in parse_changelog(base_text)}
    head_headings = {version for version, _stamp in parse_changelog(head_text)}
    missing = sorted(str(version) for version in base_headings - head_headings)
    if missing:
        raise ContractError(f"changelog dropped released heading(s): {', '.join(missing)}")


def validate_snapshot(files: Mapping[str, str]) -> ReleaseIntent:
    """Prove all seven locks agree on one version, in one committed tree."""
    missing = sorted(set(RELEASE_LOCK_PATHS).difference(files))
    if missing:
        raise ContractError(f"release snapshot is missing: {', '.join(missing)}")

    version = Version.parse(files["VERSION"])

    try:
        cargo = tomllib.loads(files["Cargo.toml"])
    except tomllib.TOMLDecodeError as exc:
        raise ContractError("Cargo.toml is not valid TOML") from exc
    workspace = cargo.get("workspace")
    package = workspace.get("package") if isinstance(workspace, dict) else None
    if not isinstance(package, dict) or not isinstance(package.get("version"), str):
        raise ContractError("Cargo.toml has no [workspace.package] version string")
    if Version.parse(package["version"]) != version:
        raise ContractError("Cargo.toml workspace version does not equal VERSION")

    chart = files["chart/Chart.yaml"]
    if Version.parse(_top_level_scalar(chart, "version")) != version:
        raise ContractError("chart version does not equal VERSION")
    if Version.parse(_top_level_scalar(chart, "appVersion")) != version:
        raise ContractError("chart appVersion does not equal VERSION")

    if _direct_child_scalar(files["chart/values.yaml"], "image", "tag") != version.tag:
        raise ContractError("chart image tag does not equal v<VERSION>")

    try:
        manifest = json.loads(files["plugin/manifest.json"])
    except json.JSONDecodeError as exc:
        raise ContractError("plugin/manifest.json is not valid JSON") from exc
    if not isinstance(manifest, dict) or not isinstance(manifest.get("version"), str):
        raise ContractError("plugin/manifest.json has no version string")
    if Version.parse(manifest["version"]) != version:
        raise ContractError("plugin manifest version does not equal VERSION")

    headings = parse_changelog(files["CHANGELOG.md"])
    if headings[0][0] != version:
        raise ContractError(
            f"changelog's topmost heading is {headings[0][0]}, not the released version {version}"
        )
    if sum(1 for entry, _stamp in headings if entry == version) != 1:
        raise ContractError("changelog must carry exactly one heading for the released version")
    return ReleaseIntent(source_sha="", version=version)


# --------------------------------------------------------------------------
# Chart digest substitution
# --------------------------------------------------------------------------


def _require_digest(raw: object, field: str) -> str:
    if not isinstance(raw, str) or not DIGEST_RE.fullmatch(raw):
        raise ContractError(f"{field} must be sha256:<64 lowercase hex>")
    return raw


def require_publishable_digest(raw: object, field: str) -> str:
    """Well formed AND not the fail-closed sentinel; neither implies the other."""
    digest = _require_digest(raw, field)
    if digest == CHART_DIGEST_SENTINEL:
        raise ContractError(f"{field} is the all-zeros fail-closed sentinel, not a resolved digest")
    return digest


def assert_chart_image_digest(values: str, digest: str) -> None:
    """Read-only, and usable against a PACKAGED chart, not only the work tree."""
    expected = require_publishable_digest(digest, "expected image digest")
    if CHART_DIGEST_SENTINEL in values:
        raise ContractError("chart values still carry the all-zeros fail-closed digest sentinel")
    observed = _direct_child_scalar(values, "image", "digest")
    if observed != expected:
        raise ContractError(f"chart image digest {observed!r} is not the resolved {expected!r}")


def embed_chart_image_digest(values: str, digest: str) -> str:
    """Replace the committed sentinel with the resolved digest, exactly once."""
    expected = require_publishable_digest(digest, "embedded image digest")
    observed = _direct_child_scalar(values, "image", "digest")
    if observed != CHART_DIGEST_SENTINEL:
        raise ContractError(
            f"chart image digest is {observed!r}; the committed chart must carry the "
            "all-zeros fail-closed sentinel before substitution"
        )
    embedded, count = CHART_DIGEST_LINE_RE.subn(lambda _m: f"  digest: {expected}", values)
    if count != 1:
        raise ContractError(f"expected exactly one substitutable digest line, found {count}")
    assert_chart_image_digest(embedded, expected)
    return embedded


# --------------------------------------------------------------------------
# Git walk
# --------------------------------------------------------------------------


def _git(repository: Path, *args: str) -> str:
    completed = subprocess.run(
        ["git", "-C", str(repository), *args],
        check=False,
        capture_output=True,
        text=True,
        encoding="utf-8",
    )
    if completed.returncode != 0:
        raise ContractError(f"git {' '.join(args)} failed")
    return completed.stdout.strip()


def _git_file(repository: Path, revision: str, path: str) -> str:
    completed = subprocess.run(
        ["git", "-C", str(repository), "show", f"{revision}:{path}"],
        check=False,
        capture_output=True,
        text=True,
        encoding="utf-8",
    )
    if completed.returncode != 0:
        raise ContractError(f"{path} is absent at {revision}")
    return completed.stdout


def _version_at(repository: Path, revision: str) -> Version | None:
    completed = subprocess.run(
        ["git", "-C", str(repository), "show", f"{revision}:VERSION"],
        check=False,
        capture_output=True,
        text=True,
        encoding="utf-8",
    )
    if completed.returncode != 0:
        return None
    return Version.parse(completed.stdout)


def _linear_commits(repository: Path, base_sha: str, head_sha: str) -> list[str]:
    """Every commit in one contiguous, merge-free base..head range."""
    _git(repository, "merge-base", "--is-ancestor", base_sha, head_sha)
    raw = _git(repository, "rev-list", "--first-parent", "--reverse", f"{base_sha}..{head_sha}")
    commits = raw.splitlines() if raw else []
    if not commits or commits[-1] != head_sha:
        raise ContractError("release range is empty or does not end at the exact head")
    previous = base_sha
    for commit in commits:
        fields = _git(repository, "rev-list", "--parents", "-n", "1", commit).split()
        if len(fields) != 2 or fields[0] != commit or fields[1] != previous:
            raise ContractError("release range must be one contiguous linear commit chain")
        previous = commit
    return commits


def _first_parent_history(repository: Path, head_sha: str) -> list[str]:
    raw = _git(repository, "rev-list", "--first-parent", "--reverse", head_sha)
    commits = raw.splitlines() if raw else []
    if not commits or commits[-1] != head_sha:
        raise ContractError("release history is empty or does not end at the exact head")
    previous: str | None = None
    for commit in commits:
        fields = _git(repository, "rev-list", "--parents", "-n", "1", commit).split()
        if fields[0] != commit:
            raise ContractError("release history commit identity is not exact")
        if previous is None:
            if len(fields) != 1:
                raise ContractError("release history root must have no parent")
        elif len(fields) < 2 or fields[1] != previous:
            raise ContractError("release history first-parent chain is not contiguous")
        previous = commit
    return commits


def _monotonic_transitions(
    repository: Path, base_sha: str, commits: list[str]
) -> list[tuple[str, str, Version]]:
    """Classify every exact patch boundary; refuse skip, reversion, deletion."""
    current = _version_at(repository, base_sha)
    if current is None:
        raise ContractError("release transition base must contain VERSION")
    previous = base_sha
    transitions: list[tuple[str, str, Version]] = []
    for commit in commits:
        observed = _version_at(repository, commit)
        if observed == current:
            previous = commit
            continue
        expected = Version(current.major, current.minor, current.patch + 1)
        if observed != expected:
            rendered = "absent" if observed is None else str(observed)
            raise ContractError(
                f"commit {commit} version {rendered} must remain at {current} "
                f"or advance exactly once to {expected}"
            )
        transitions.append((previous, commit, expected))
        current = expected
        previous = commit
    return transitions


def _validated_history_transitions(
    repository: Path, head_sha: str
) -> list[tuple[str, str, Version]]:
    """Prove every publisher-visible VERSION state on the whole mainline."""
    history = _first_parent_history(repository, head_sha)
    baseline_index = next(
        (index for index, commit in enumerate(history) if _version_at(repository, commit)),
        None,
    )
    if baseline_index is None:
        raise ContractError("release history contains no VERSION baseline")
    return _monotonic_transitions(
        repository, history[baseline_index], history[baseline_index + 1 :]
    )


def is_documentation_path(path: str) -> bool:
    """The closed documentation allowlist. Widening it is a released change."""
    if path in DOCUMENTATION_FILES:
        return True
    return path.startswith(DOCUMENTATION_TREE) and path.endswith(".md")


def _diff_entries(repository: Path, base: str, commit: str) -> list[tuple[str, str, str, str]]:
    completed = subprocess.run(
        [
            "git", "-C", str(repository), "diff", "--raw", "-z",
            "--no-renames", "--no-color", base, commit,
        ],
        check=False,
        capture_output=True,
    )
    if completed.returncode != 0:
        raise ContractError(f"git diff walk failed between {base} and {commit}")
    try:
        raw = completed.stdout.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise ContractError(f"diff between {base} and {commit} carries undecodable paths") from exc
    fields = raw.split("\0")
    if fields and fields[-1] == "":
        fields.pop()
    if len(fields) % 2 != 0:
        raise ContractError(f"diff between {base} and {commit} is not meta/path paired")
    entries: list[tuple[str, str, str, str]] = []
    for meta, path in zip(fields[0::2], fields[1::2]):
        if not re.fullmatch(
            r":[0-7]{6} [0-7]{6} [0-9a-f]{7,64} [0-9a-f]{7,64} [ACDMTUX]", meta
        ) or not path:
            raise ContractError(f"diff entry between {base} and {commit} is malformed")
        parts = meta.split(" ")
        entries.append((parts[0][1:], parts[1], parts[4], path))
    return entries


def _undocumented_paths(repository: Path, base: str, commit: str) -> list[str]:
    offending: list[str] = []
    for src_mode, dst_mode, status, path in _diff_entries(repository, base, commit):
        if status not in _DIFF_STATUSES:
            offending.append(path)
        elif src_mode not in _DIFF_MODES or dst_mode not in _DIFF_MODES:
            offending.append(path)
        elif not is_documentation_path(path):
            offending.append(path)
    return offending


def classify_transition(
    repository: Path, base_sha: str, head_sha: str, *, first_parent: bool
) -> dict[str, object]:
    """Classify one protected range as artifact or no-artifact, fail closed."""
    base_sha = require_sha(base_sha, "base SHA")
    head_sha = require_sha(head_sha, "head SHA")
    if _git(repository, "rev-parse", f"{base_sha}^{{commit}}") != base_sha:
        raise ContractError("base SHA did not resolve exactly")
    if _git(repository, "rev-parse", f"{head_sha}^{{commit}}") != head_sha:
        raise ContractError("head SHA did not resolve exactly")
    commits = _linear_commits(repository, base_sha, head_sha)
    offending: list[str] = []
    previous = base_sha
    for commit in commits:
        offending.extend(_undocumented_paths(repository, previous, commit))
        previous = commit
    if offending:
        if not _monotonic_transitions(repository, base_sha, commits):
            raise ContractError(
                "artifact-surface paths changed without one exact release patch: "
                + ", ".join(sorted(set(offending))[:8])
            )
        intent = validate_transition(repository, base_sha, head_sha, first_parent=first_parent)
        return {
            "class": "artifact",
            "base_sha": base_sha,
            "source_sha": intent.source_sha,
            "version": str(intent.version),
            "tag": intent.tag,
        }
    # STRUCTURAL BACKSTOPS, and deliberately kept. Neither of the two checks
    # below can fail today: no release lock is in the documentation allowlist,
    # so a range that touched one already left `offending` non-empty and took
    # the artifact path above. They exist for the day somebody widens
    # `is_documentation_path` -- the one edit that would make a lock change
    # look like documentation -- so that widening fails loudly here instead of
    # silently retiring the release. They are backstops, not live guards, and
    # should not be scored as either passing or decorative checks.
    boundaries = _monotonic_transitions(repository, base_sha, commits)
    if boundaries:
        raise ContractError(
            "documentation-only range must contain exactly 0 one-patch boundaries; "
            f"found {len(boundaries)}"
        )
    for path in RELEASE_LOCK_PATHS:
        if _git_file(repository, base_sha, path) != _git_file(repository, head_sha, path):
            raise ContractError(f"documentation-only range mutated release lock {path}")
    retained = validate_snapshot(
        {path: _git_file(repository, head_sha, path) for path in RELEASE_LOCK_PATHS}
    )
    return {
        "class": "no-artifact",
        "base_sha": base_sha,
        "source_sha": head_sha,
        "version": str(retained.version),
        "tag": retained.tag,
        "commits": len(commits),
    }


def validate_transition(
    repository: Path, base_sha: str, head_sha: str, *, first_parent: bool
) -> ReleaseIntent:
    base_sha = require_sha(base_sha, "base SHA")
    head_sha = require_sha(head_sha, "head SHA")
    commits = _linear_commits(repository, base_sha, head_sha)
    transitions = _monotonic_transitions(repository, base_sha, commits)
    if len(transitions) != 1:
        raise ContractError("release range must contain exactly one patch boundary")
    if first_parent:
        history = _validated_history_transitions(repository, head_sha)
        if not history or history[-1] != transitions[0]:
            raise ContractError("release range boundary is not the publisher-visible boundary")
    base_version = Version.parse(_git_file(repository, base_sha, "VERSION"))
    head_files = {path: _git_file(repository, head_sha, path) for path in RELEASE_LOCK_PATHS}
    head = validate_snapshot(head_files)
    require_appended_changelog(
        _git_file(repository, base_sha, "CHANGELOG.md"), head_files["CHANGELOG.md"]
    )
    require_next_patch(base_version, head.version)
    return ReleaseIntent(source_sha=head_sha, version=head.version)


def discover_transition_window(repository: Path, head_sha: str) -> TransitionWindow:
    """Recover the last boundary from the exhaustively validated mainline."""
    head_sha = require_sha(head_sha, "head SHA")
    if _git(repository, "rev-parse", f"{head_sha}^{{commit}}") != head_sha:
        raise ContractError("head SHA did not resolve exactly")
    transitions = _validated_history_transitions(repository, head_sha)
    if not transitions:
        raise ContractError("release history contains no patch boundary")
    head = validate_snapshot(
        {path: _git_file(repository, head_sha, path) for path in RELEASE_LOCK_PATHS}
    )
    base_sha, _commit, transition_version = transitions[-1]
    if transition_version != head.version:
        raise ContractError("release head does not retain the last patch boundary")
    return TransitionWindow(
        base_sha=base_sha, intent=ReleaseIntent(source_sha=head_sha, version=head.version)
    )


# --------------------------------------------------------------------------
# GitHub event and run records
# --------------------------------------------------------------------------


def plan_workflow_run(event: Mapping[str, object], expected_repository: str) -> str:
    repository = event.get("repository")
    run = event.get("workflow_run")
    if not isinstance(repository, Mapping) or repository.get("full_name") != expected_repository:
        raise ContractError("workflow_run repository identity mismatch")
    if not isinstance(run, Mapping):
        raise ContractError("workflow_run payload is absent")
    for key, expected in {
        "name": EXPECTED_WORKFLOW,
        "event": "push",
        "status": "completed",
        "conclusion": "success",
        "head_branch": "main",
    }.items():
        if run.get(key) != expected:
            raise ContractError(f"workflow_run {key} must equal {expected!r}")
    path = run.get("path")
    if not isinstance(path, str) or path.split("@", 1)[0] != EXPECTED_WORKFLOW_PATH:
        raise ContractError("workflow_run path is not the protected PR gate")
    head_repository = run.get("head_repository")
    if (
        not isinstance(head_repository, Mapping)
        or head_repository.get("full_name") != expected_repository
    ):
        raise ContractError("workflow_run head repository identity mismatch")
    return require_sha(run.get("head_sha"), "workflow_run head SHA")


def validate_main_run_record(
    run: Mapping[str, object],
    *,
    expected_repository: str,
    expected_run_id: int,
    expected_source_sha: str,
) -> str:
    if (
        isinstance(expected_run_id, bool)
        or not isinstance(expected_run_id, int)
        or expected_run_id <= 0
        or run.get("id") != expected_run_id
    ):
        raise ContractError("Actions run ID is not the exact positive requested run ID")
    for field in ("repository", "head_repository"):
        record = _object(run.get(field), f"Actions run {field}")
        if record.get("full_name") != expected_repository:
            raise ContractError(f"Actions run {field} identity mismatch")
    for key, expected in {
        "name": EXPECTED_WORKFLOW,
        "path": EXPECTED_WORKFLOW_PATH,
        "event": "push",
        "status": "completed",
        "conclusion": "success",
        "head_branch": "main",
    }.items():
        if run.get(key) != expected:
            raise ContractError(f"Actions run {key} must equal {expected!r}")
    source_sha = require_sha(expected_source_sha, "publisher source SHA")
    if require_sha(run.get("head_sha"), "Actions run head SHA") != source_sha:
        raise ContractError("successful main run does not bind the requested source SHA")
    return source_sha


def _validate_job_inventory(
    record: Mapping[str, object],
    *,
    expected: Mapping[str, str],
    expected_run_id: int,
    expected_source_sha: str,
    label: str,
) -> str:
    if isinstance(expected_run_id, bool) or not isinstance(expected_run_id, int) or expected_run_id <= 0:
        raise ContractError(f"{label} jobs run ID must be positive")
    source_sha = require_sha(expected_source_sha, f"{label} jobs source SHA")
    jobs = _array(record.get("jobs"), f"{label} jobs")
    total_count = record.get("total_count")
    if isinstance(total_count, bool) or total_count != len(jobs):
        raise ContractError(f"{label} jobs total_count does not equal the returned job count")
    if len(jobs) != len(expected):
        raise ContractError(f"{label} run does not contain the exact job count")
    observed: dict[str, str] = {}
    job_ids: set[int] = set()
    for raw_job in jobs:
        job = _object(raw_job, f"{label} job")
        job_id = job.get("id")
        if isinstance(job_id, bool) or not isinstance(job_id, int) or job_id <= 0:
            raise ContractError(f"{label} job ID must be a positive integer")
        if job_id in job_ids:
            raise ContractError(f"{label} jobs contain a duplicate job ID")
        job_ids.add(job_id)
        if job.get("run_id") != expected_run_id:
            raise ContractError(f"{label} job belongs to a different run")
        if require_sha(job.get("head_sha"), f"{label} job head SHA") != source_sha:
            raise ContractError(f"{label} job belongs to a different source SHA")
        name = job.get("name")
        if not isinstance(name, str) or name not in expected:
            raise ContractError(f"{label} jobs contain a missing or foreign job name")
        if name in observed:
            raise ContractError(f"{label} jobs contain a duplicate job name")
        if job.get("status") != "completed":
            raise ContractError(f"{label} job {name!r} is not completed")
        if job.get("conclusion") != expected[name]:
            raise ContractError(f"{label} job {name!r} conclusion must equal {expected[name]!r}")
        observed[name] = expected[name]
    # No closing `observed == expected` comparison: the exact length check
    # above, plus the per-job refusals of a foreign or duplicated name, already
    # force it. An assertion no input can fail is decorative, and a decorative
    # check next to real ones teaches a reader to trust the wrong thing.
    return source_sha


def validate_main_jobs_record(
    record: Mapping[str, object], *, expected_run_id: int, expected_source_sha: str
) -> str:
    return _validate_job_inventory(
        record,
        expected=EXPECTED_MAIN_JOBS,
        expected_run_id=expected_run_id,
        expected_source_sha=expected_source_sha,
        label="Actions",
    )


def validate_codeql_jobs_record(
    record: Mapping[str, object], *, expected_run_id: int, expected_source_sha: str
) -> str:
    return _validate_job_inventory(
        record,
        expected=EXPECTED_CODEQL_JOBS,
        expected_run_id=expected_run_id,
        expected_source_sha=expected_source_sha,
        label="CodeQL",
    )


def classify_codeql_run_record(
    record: Mapping[str, object], *, expected_repository: str, expected_source_sha: str
) -> int | None:
    """Resolve exactly one CodeQL push run for the authorized main SHA."""
    source_sha = require_sha(expected_source_sha, "CodeQL source SHA")
    runs = _array(record.get("workflow_runs"), "CodeQL workflow runs")
    total_count = record.get("total_count")
    if isinstance(total_count, bool) or total_count != len(runs):
        raise ContractError("CodeQL run total_count does not equal the returned run count")
    if not runs:
        return None
    if len(runs) != 1:
        raise ContractError("CodeQL exact-SHA query returned duplicate or foreign runs")
    run = _object(runs[0], "CodeQL workflow run")
    run_id = run.get("id")
    if isinstance(run_id, bool) or not isinstance(run_id, int) or run_id <= 0:
        raise ContractError("CodeQL run ID must be a positive integer")
    for field in ("repository", "head_repository"):
        record_field = _object(run.get(field), f"CodeQL run {field}")
        if record_field.get("full_name") != expected_repository:
            raise ContractError(f"CodeQL run {field} identity mismatch")
    for key, expected in {
        "name": EXPECTED_CODEQL_WORKFLOW,
        "path": EXPECTED_CODEQL_WORKFLOW_PATH,
        "event": "push",
        "head_branch": "main",
        "head_sha": source_sha,
    }.items():
        if run.get(key) != expected:
            raise ContractError(f"CodeQL run {key} must equal {expected!r}")
    status = run.get("status")
    if status in {"queued", "in_progress", "waiting", "requested", "pending"}:
        if run.get("conclusion") is not None:
            raise ContractError("incomplete CodeQL run already has a conclusion")
        return None
    if status != "completed" or run.get("conclusion") != "success":
        raise ContractError("exact-SHA CodeQL run is not completed successfully")
    return run_id


def validate_release_destinations(repository: str, image: str, chart: str) -> None:
    if repository != EXPECTED_REPOSITORY:
        raise ContractError("release repository identity is not exact")
    if image != EXPECTED_IMAGE:
        raise ContractError("release image package identity is not exact")
    if chart != EXPECTED_CHART:
        raise ContractError("release chart package identity is not exact")


def validate_publisher(
    root: Path,
    source_sha: str,
    checkout_sha: str,
    ref: str,
    event_name: str,
    repository: str,
    workflow_ref: str,
    image: str,
    chart: str,
) -> ReleaseIntent:
    """Bind protected workflow, authorized checkout, and committed locks."""
    source_sha = require_sha(source_sha, "publisher source SHA")
    checkout_sha = require_sha(checkout_sha, "publisher checkout SHA")
    if event_name != "workflow_dispatch":
        raise ContractError("publisher accepts only explicit workflow_dispatch")
    if ref != "refs/heads/main":
        raise ContractError("publisher workflow must be selected from protected main")
    if workflow_ref != f"{repository}/{EXPECTED_PUBLISHER_PATH}@refs/heads/main":
        raise ContractError("publisher workflow identity is not protected main")
    validate_release_destinations(repository, image, chart)
    if source_sha != checkout_sha:
        raise ContractError("publisher source SHA does not equal the authorized checkout")
    files = {path: (root / path).read_text(encoding="utf-8") for path in RELEASE_LOCK_PATHS}
    return ReleaseIntent(source_sha=source_sha, version=validate_snapshot(files).version)


# --------------------------------------------------------------------------
# Tag, Release, and evidence records
# --------------------------------------------------------------------------


def _canonical_json(record: Mapping[str, object]) -> bytes:
    return json.dumps(record, sort_keys=True, separators=(",", ":")).encode("utf-8") + b"\n"


def _same_instant(actual: object, expected: str, field: str) -> None:
    if not isinstance(actual, str):
        raise ContractError(f"{field} must be an ISO-8601 timestamp")
    try:
        actual_time = dt.datetime.fromisoformat(actual.replace("Z", "+00:00"))
        expected_time = dt.datetime.fromisoformat(expected.replace("Z", "+00:00"))
    except ValueError as exc:
        raise ContractError(f"{field} must be an ISO-8601 timestamp") from exc
    if actual_time.tzinfo is None or expected_time.tzinfo is None or actual_time != expected_time:
        raise ContractError(f"{field} does not equal the deterministic source-commit instant")


def validate_tag_record(
    ref_record: Mapping[str, object],
    tag_record: Mapping[str, object],
    *,
    tag: str,
    source_sha: str,
    message: str,
    tagger_name: str,
    tagger_email: str,
    tagger_date: str,
) -> None:
    source_sha = require_sha(source_sha, "tag source SHA")
    if ref_record.get("ref") != f"refs/tags/{tag}":
        raise ContractError("tag ref name is not exact")
    ref_object = _object(ref_record.get("object"), "tag ref object")
    if ref_object.get("type") != "tag":
        raise ContractError("release tag must be annotated, never lightweight")
    if require_sha(ref_object.get("sha"), "tag object SHA") != tag_record.get("sha"):
        raise ContractError("tag ref and tag object disagree")
    if tag_record.get("tag") != tag:
        raise ContractError("tag object name is not exact")
    if tag_record.get("message") != message:
        raise ContractError("tag object message is not exact")
    tagged = _object(tag_record.get("object"), "tag target")
    if tagged.get("type") != "commit" or require_sha(tagged.get("sha"), "tag target SHA") != source_sha:
        raise ContractError("tag does not point at the exact authorized source commit")
    tagger = _object(tag_record.get("tagger"), "tag tagger")
    if tagger.get("name") != tagger_name or tagger.get("email") != tagger_email:
        raise ContractError("tag tagger identity is not exact")
    _same_instant(tagger.get("date"), tagger_date, "tag tagger date")


def classify_tag_state(
    http_status: int,
    ref_record: Mapping[str, object] | None,
    tag_record: Mapping[str, object] | None,
    **expected: str,
) -> str:
    if http_status == 404:
        if ref_record is not None or tag_record is not None:
            raise ContractError("absent tag state cannot carry tag records")
        return "absent"
    if http_status != 200:
        raise ContractError(f"tag ref probe returned unexpected HTTP {http_status}")
    if ref_record is None or tag_record is None:
        raise ContractError("present tag state requires both REST tag records")
    validate_tag_record(ref_record, tag_record, **expected)
    return "exact"


def release_manifest_asset_name(tag: str) -> str:
    if not re.fullmatch(r"v" + SEMVER_RE.pattern[1:-1], tag):
        raise ContractError("release manifest tag is malformed")
    return f"obsync-{tag}-release-manifest.json"


def plugin_bundle_asset_name(tag: str) -> str:
    if not re.fullmatch(r"v" + SEMVER_RE.pattern[1:-1], tag):
        raise ContractError("plugin bundle tag is malformed")
    return f"obsync-plugin-{tag}.zip"


def build_release_manifest(
    *,
    repository: str,
    source_sha: str,
    main_run_id: int,
    version: str,
    image: str,
    image_digest: str,
    chart: str,
    chart_digest: str,
    plugin_digest: str,
) -> dict[str, object]:
    """The one canonical, deterministic publication evidence asset."""
    validate_release_destinations(repository, image, chart)
    source_sha = require_sha(source_sha, "release manifest source SHA")
    if isinstance(main_run_id, bool) or not isinstance(main_run_id, int) or main_run_id <= 0:
        raise ContractError("release manifest main run ID must be positive")
    parsed = Version.parse(version)
    image_digest = require_publishable_digest(image_digest, "release manifest image digest")
    chart_digest = require_publishable_digest(chart_digest, "release manifest chart digest")
    plugin_digest = _require_digest(plugin_digest, "release manifest plugin bundle digest")
    identity = f"https://github.com/{repository}/{RELEASE_MANIFEST_WORKFLOW}@refs/heads/main"
    policy = {
        "scanner": "trivy",
        "scanner_version": TRIVY_VERSION,
        "severities": list(TRIVY_SEVERITIES),
        "ignore_unfixed": False,
        "result": "pass",
    }
    return {
        "schema": RELEASE_MANIFEST_SCHEMA,
        "repository": repository,
        "source_sha": source_sha,
        "main_run_id": main_run_id,
        "release": {"version": str(parsed), "tag": parsed.tag},
        "publisher": {"workflow": RELEASE_MANIFEST_WORKFLOW, "ref": "refs/heads/main"},
        "artifacts": {
            "image": {
                "repository": image,
                "tag": parsed.tag,
                "digest": image_digest,
                "platforms": list(RELEASE_MANIFEST_PLATFORMS),
                "signature_identity": identity,
            },
            "chart": {
                "repository": chart,
                "tag": str(parsed),
                "digest": chart_digest,
                "signature_identity": identity,
            },
            "plugin_bundle": {
                "name": plugin_bundle_asset_name(parsed.tag),
                "digest": plugin_digest,
                "contents": ["main.js", "manifest.json", "styles.css"],
            },
        },
        "vulnerability_scans": {
            "source": {**copy.deepcopy(policy), "target": source_sha, "main_run_id": main_run_id},
            "image": {**copy.deepcopy(policy), "target": f"{image}@{image_digest}"},
        },
    }


def validate_release_manifest_record(
    manifest: Mapping[str, object],
    *,
    repository: str,
    source_sha: str,
    main_run_id: int,
    version: str,
    image: str,
    image_digest: str,
    chart: str,
    chart_digest: str,
    plugin_digest: str,
) -> None:
    expected = build_release_manifest(
        repository=repository,
        source_sha=source_sha,
        main_run_id=main_run_id,
        version=version,
        image=image,
        image_digest=image_digest,
        chart=chart,
        chart_digest=chart_digest,
        plugin_digest=plugin_digest,
    )
    if manifest != expected:
        raise ContractError("release manifest is not the exact canonical evidence record")


def build_release_notes(manifest: Mapping[str, object]) -> str:
    release = _object(manifest.get("release"), "release manifest release")
    artifacts = _object(manifest.get("artifacts"), "release manifest artifacts")
    image = _object(artifacts.get("image"), "release manifest image")
    chart = _object(artifacts.get("chart"), "release manifest chart")
    plugin = _object(artifacts.get("plugin_bundle"), "release manifest plugin bundle")
    tag = str(release.get("tag"))
    asset_name = release_manifest_asset_name(tag)
    asset_digest = "sha256:" + hashlib.sha256(_canonical_json(manifest)).hexdigest()
    return (
        f"## obsync {tag}\n\n"
        "Immutable artifacts (deploy by digest, never by tag):\n\n"
        "| Artifact | Reference |\n| --- | --- |\n"
        f"| Image | `{image.get('repository')}:{image.get('tag')}@{image.get('digest')}` |\n"
        f"| Chart | `{chart.get('repository')}:{chart.get('tag')}@{chart.get('digest')}` |\n"
        f"| Plugin | `{plugin.get('name')}` (`{plugin.get('digest')}`) |\n"
        "\nImage and chart are signed with keyless Cosign by this workflow identity.\n"
        f"\nPublication evidence: `{asset_name}` (`{asset_digest}`).\n"
        "\nSee CHANGELOG.md for human-readable changes.\n"
    )


def _validate_release_actor(value: object, field: str) -> None:
    actor = _object(value, field)
    actor_id = actor.get("id")
    if (
        actor.get("login") != GITHUB_ACTIONS_BOT_LOGIN
        or isinstance(actor_id, bool)
        or actor_id != GITHUB_ACTIONS_BOT_ID
    ):
        raise ContractError(f"{field} is not the workflow bot")


def _validate_release_assets(
    assets: object, *, tag: str, manifest: bytes, plugin_digest: str
) -> None:
    records = _array(assets, "GitHub Release assets")
    if len(records) != 2:
        raise ContractError("GitHub Release must carry exactly the manifest and the plugin bundle")
    expected = {
        release_manifest_asset_name(tag): {
            "content_type": "application/json",
            "state": "uploaded",
            "size": len(manifest),
            "digest": "sha256:" + hashlib.sha256(manifest).hexdigest(),
        },
        plugin_bundle_asset_name(tag): {
            "content_type": "application/zip",
            "state": "uploaded",
            "digest": _require_digest(plugin_digest, "plugin bundle digest"),
        },
    }
    seen: set[str] = set()
    for raw in records:
        asset = _object(raw, "GitHub Release asset")
        _validate_release_actor(asset.get("uploader"), "GitHub Release asset uploader")
        name = asset.get("name")
        if not isinstance(name, str) or name not in expected or name in seen:
            raise ContractError("GitHub Release asset name is missing, foreign, or duplicated")
        seen.add(name)
        for field, value in expected[name].items():
            if asset.get(field) != value:
                raise ContractError(f"GitHub Release asset {name} {field} is not exact")


def validate_release_record(
    release_record: Mapping[str, object],
    *,
    tag: str,
    title: str,
    body: str,
    manifest: bytes,
    plugin_digest: str,
    state: str = "exact",
) -> None:
    _validate_release_actor(release_record.get("author"), "GitHub Release author")
    if release_record.get("tag_name") != tag or release_record.get("name") != title:
        raise ContractError("GitHub Release tag or title is not exact")
    actual_body = release_record.get("body")
    if not isinstance(actual_body, str) or actual_body.rstrip("\r\n") != body.rstrip("\r\n"):
        raise ContractError("GitHub Release notes are not exact")
    if release_record.get("prerelease") is not False:
        raise ContractError("GitHub Release must be non-prerelease")
    if state in {"prepared", "staged"}:
        if release_record.get("draft") is not True or release_record.get("immutable") is not False:
            raise ContractError("prepared/staged GitHub Release must be mutable draft state")
    elif state == "exact":
        if release_record.get("draft") is not False or release_record.get("immutable") is not True:
            raise ContractError("published GitHub Release must report immutable state")
    else:
        raise ContractError("unknown GitHub Release validation state")
    if state == "prepared":
        if release_record.get("assets") != []:
            raise ContractError("prepared GitHub Release asset inventory must be exactly empty")
        return
    _validate_release_assets(
        release_record.get("assets"), tag=tag, manifest=manifest, plugin_digest=plugin_digest
    )


def classify_release_state(
    http_status: int,
    release_record: Mapping[str, object] | None,
    *,
    tag: str,
    title: str,
    body: str,
    manifest: bytes,
    plugin_digest: str,
) -> str:
    if http_status == 404:
        if release_record is not None:
            raise ContractError("absent GitHub Release state cannot carry a record")
        return "absent"
    if http_status != 200:
        raise ContractError(f"GitHub Release probe returned unexpected HTTP {http_status}")
    if release_record is None:
        raise ContractError("present GitHub Release state requires its REST record")
    if release_record.get("draft") is True and release_record.get("immutable") is False:
        state = "prepared" if release_record.get("assets") == [] else "staged"
    elif release_record.get("draft") is False and release_record.get("immutable") is True:
        state = "exact"
    else:
        raise ContractError("present GitHub Release is neither exact staged nor immutable state")
    validate_release_record(
        release_record,
        tag=tag,
        title=title,
        body=body,
        manifest=manifest,
        plugin_digest=plugin_digest,
        state=state,
    )
    return state


def require_publication_state(actual: str, required: str) -> str:
    if required not in {"absent", "prepared", "staged", "exact"} or actual != required:
        raise ContractError(f"publication state {actual!r} does not equal required {required!r}")
    return actual


def classify_artifact(
    *, present: bool, source_match: bool, signature_match: bool
) -> str:
    """absent, complete, or burned. A burned alias never re-publishes silently."""
    if not present:
        if source_match or signature_match:
            raise ContractError("absent artifact cannot carry positive evidence")
        return "absent"
    return "complete" if source_match and signature_match else "burned"


def classify_registry_response(http_status: int) -> str:
    if http_status == 200:
        return "present"
    if http_status == 404:
        return "absent"
    raise ContractError(f"registry manifest probe returned unexpected HTTP {http_status}")


# --------------------------------------------------------------------------
# Governance receipt (docs/release.md, "Governance receipt")
# --------------------------------------------------------------------------

SETTINGS_RECEIPT_FIELDS = (
    "allow_deletions",
    "allow_force_pushes",
    "branch",
    "default_workflow_permissions",
    "immutable_releases",
    "merge_methods",
    "repository",
    "require_linear_history",
    "require_pull_request",
    "require_signed_commits",
    "required_status_checks",
    "restrict_creations",
    "secret_scanning",
    "secret_scanning_push_protection",
    "strict_status_checks",
)


def _status_check_set(value: object) -> set[tuple[str, int]]:
    checks: set[tuple[str, int]] = set()
    for raw in _array(value, "required status checks"):
        check = _object(raw, "required status check")
        context = check.get("context")
        integration = check.get("integration_id")
        if not isinstance(context, str) or isinstance(integration, bool) or not isinstance(integration, int):
            raise ContractError("required status check is not a bound context/integration pair")
        checks.add((context, integration))
    return checks


def validate_settings_receipt(receipt: Mapping[str, object], repository: str) -> None:
    """The closed, value-only release-readiness receipt the owner activates."""
    if set(receipt) != set(SETTINGS_RECEIPT_FIELDS):
        raise ContractError("settings receipt fields are missing or foreign")
    if receipt.get("repository") != repository or receipt.get("branch") != "main":
        raise ContractError("settings receipt repository or branch is not exact")
    methods = {str(method) for method in _array(receipt.get("merge_methods"), "merge methods")}
    if methods != {"rebase", "squash"}:
        raise ContractError("only squash and rebase merge methods may be enabled")
    expected_checks = {
        (context, GITHUB_ACTIONS_INTEGRATION_ID) for context in REQUIRED_STATUS_CHECKS
    }
    if _status_check_set(receipt.get("required_status_checks")) != expected_checks:
        raise ContractError("required GitHub Actions checks are missing, foreign, or unbound")
    if receipt.get("default_workflow_permissions") != "read":
        raise ContractError("default workflow token permissions must be read-only")
    for field, expected in (
        ("immutable_releases", True),
        ("strict_status_checks", True),
        ("require_pull_request", True),
        ("require_linear_history", True),
        ("require_signed_commits", True),
        ("restrict_creations", True),
        ("secret_scanning", True),
        ("secret_scanning_push_protection", True),
        ("allow_force_pushes", False),
        ("allow_deletions", False),
    ):
        if receipt.get(field) is not expected:
            raise ContractError(f"settings receipt {field} must be {expected}")


def _github_api_get(endpoint: str, *, paginate: bool = False) -> object:
    command = [
        "gh", "api", "--method", "GET",
        "--header", "Accept: application/vnd.github+json",
        "--header", f"X-GitHub-Api-Version: {GITHUB_API_VERSION}",
    ]
    if paginate:
        command.extend(("--paginate", "--slurp"))
    command.append(endpoint)
    completed = subprocess.run(command, check=False, capture_output=True, text=True)
    if completed.returncode != 0:
        raise ContractError("read-only GitHub settings query failed")
    try:
        value = json.loads(completed.stdout)
    except json.JSONDecodeError as exc:
        raise ContractError("read-only GitHub settings query returned malformed JSON") from exc
    if not paginate:
        return value
    flattened: list[object] = []
    for page in _array(value, "paginated GitHub settings response"):
        flattened.extend(_array(page, "paginated GitHub settings page"))
    return flattened


def _rule(rules: list[object], rule_type: str) -> Mapping[str, object] | None:
    for raw in rules:
        rule = _object(raw, "ruleset rule")
        if rule.get("type") == rule_type:
            return rule
    return None


def _rule_parameters(rules: list[object], rule_type: str) -> Mapping[str, object]:
    rule = _rule(rules, rule_type)
    if rule is None:
        return {}
    return _object(rule.get("parameters", {}), f"{rule_type} parameters")


def observe_live_settings(repository: str) -> dict[str, object]:
    """Query only GET endpoints; emit the receipt `settings-receipt` validates."""
    if not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", repository):
        raise ContractError("repository must be an exact owner/name pair")
    repository_record = _object(_github_api_get(f"repos/{repository}"), "repository settings")
    immutable = _object(
        _github_api_get(f"repos/{repository}/immutable-releases"), "immutable-release settings"
    )
    workflow_permissions = _object(
        _github_api_get(f"repos/{repository}/actions/permissions/workflow"),
        "default workflow permission settings",
    )
    summaries = _array(
        _github_api_get(f"repos/{repository}/rulesets", paginate=True), "rulesets"
    )
    active = [
        _object(summary, "ruleset summary")
        for summary in summaries
        if _object(summary, "ruleset summary").get("enforcement") == "active"
    ]
    if len(active) != 1:
        raise ContractError("expected exactly one active repository ruleset")
    ruleset = _object(
        _github_api_get(f"repos/{repository}/rulesets/{active[0]['id']}"), "main ruleset"
    )
    rules = _array(ruleset.get("rules"), "ruleset rules")
    types = {_object(rule, "ruleset rule").get("type") for rule in rules}
    security = _object(
        repository_record.get("security_and_analysis", {}), "security and analysis settings"
    )

    def _security(feature: str) -> bool:
        return _object(security.get(feature, {}), feature).get("status") == "enabled"

    allowed = _rule_parameters(rules, "pull_request").get("allowed_merge_methods")
    return {
        "repository": repository,
        "branch": "main",
        "immutable_releases": immutable.get("enabled"),
        "default_workflow_permissions": workflow_permissions.get("default_workflow_permissions"),
        "merge_methods": sorted(str(method) for method in _array(allowed or [], "merge methods")),
        "required_status_checks": [
            {
                "context": _object(check, "status check").get("context"),
                "integration_id": _object(check, "status check").get("integration_id"),
            }
            for check in _array(
                _rule_parameters(rules, "required_status_checks").get("required_status_checks", []),
                "required status checks",
            )
        ],
        "strict_status_checks": _rule_parameters(rules, "required_status_checks").get(
            "strict_required_status_checks_policy"
        ),
        "require_pull_request": "pull_request" in types,
        "require_linear_history": "required_linear_history" in types,
        "require_signed_commits": "required_signatures" in types,
        "restrict_creations": "creation" in types,
        "allow_deletions": "deletion" not in types,
        "allow_force_pushes": "non_fast_forward" not in types,
        "secret_scanning": _security("secret_scanning"),
        "secret_scanning_push_protection": _security("secret_scanning_push_protection"),
    }


# --------------------------------------------------------------------------
# CLI
# --------------------------------------------------------------------------


def _read_object(path: Path) -> Mapping[str, object]:
    return _object(json.loads(path.read_text(encoding="utf-8")), str(path))


def _emit(intent: ReleaseIntent) -> None:
    print(
        json.dumps(
            {
                "source_sha": intent.source_sha,
                "version": str(intent.version),
                "tag": intent.tag,
            },
            sort_keys=True,
        )
    )


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0] if __doc__ else None)
    commands = parser.add_subparsers(dest="command", required=True)

    transition = commands.add_parser("transition")
    transition.add_argument("--repository", type=Path, required=True)
    transition.add_argument("--base", required=True)
    transition.add_argument("--head", required=True)
    transition.add_argument("--first-parent", action="store_true")

    window = commands.add_parser("release-window")
    window.add_argument("--repository", type=Path, required=True)
    window.add_argument("--head", required=True)

    event = commands.add_parser("workflow-run")
    event.add_argument("--event", type=Path, required=True)
    event.add_argument("--repository", required=True)

    main_run = commands.add_parser("main-run-record")
    main_run.add_argument("--run-json", type=Path, required=True)
    main_run.add_argument("--run-id", type=int, required=True)
    main_run.add_argument("--repository", required=True)
    main_run.add_argument("--source-sha", required=True)

    main_jobs = commands.add_parser("main-jobs-record")
    main_jobs.add_argument("--jobs-json", type=Path, required=True)
    main_jobs.add_argument("--run-id", type=int, required=True)
    main_jobs.add_argument("--source-sha", required=True)

    codeql_run = commands.add_parser("codeql-run-record")
    codeql_run.add_argument("--runs-json", type=Path, required=True)
    codeql_run.add_argument("--repository", required=True)
    codeql_run.add_argument("--source-sha", required=True)

    codeql_jobs = commands.add_parser("codeql-jobs-record")
    codeql_jobs.add_argument("--jobs-json", type=Path, required=True)
    codeql_jobs.add_argument("--run-id", type=int, required=True)
    codeql_jobs.add_argument("--source-sha", required=True)

    publisher = commands.add_parser("publisher")
    publisher.add_argument("--root", type=Path, required=True)
    publisher.add_argument("--source-sha", required=True)
    publisher.add_argument("--checkout-sha", required=True)
    publisher.add_argument("--ref", required=True)
    publisher.add_argument("--event-name", required=True)
    publisher.add_argument("--repository", required=True)
    publisher.add_argument("--workflow-ref", required=True)
    publisher.add_argument("--image", required=True)
    publisher.add_argument("--chart", required=True)

    settings_receipt = commands.add_parser("settings-receipt")
    settings_receipt.add_argument("--receipt", type=Path, required=True)
    settings_receipt.add_argument("--repository", required=True)

    settings_preflight = commands.add_parser("settings-preflight")
    settings_preflight.add_argument("--repository", required=True)

    tag_record = commands.add_parser("tag-record")
    tag_state = commands.add_parser("tag-state")
    tag_state.add_argument("--http-status", type=int, required=True)
    tag_state.add_argument("--require", choices=("absent", "exact"))
    tag_state.add_argument("--ref-json", type=Path)
    tag_state.add_argument("--tag-json", type=Path)
    tag_record.add_argument("--ref-json", type=Path, required=True)
    tag_record.add_argument("--tag-json", type=Path, required=True)
    for command in (tag_record, tag_state):
        command.add_argument("--tag", required=True)
        command.add_argument("--source-sha", required=True)
        command.add_argument("--message", required=True)
        command.add_argument("--tagger-name", required=True)
        command.add_argument("--tagger-email", required=True)
        command.add_argument("--tagger-date", required=True)

    release_record = commands.add_parser("release-record")
    release_record.add_argument("--release-json", type=Path, required=True)
    release_state = commands.add_parser("release-state")
    release_state.add_argument("--http-status", type=int, required=True)
    release_state.add_argument("--require", choices=("absent", "prepared", "staged", "exact"))
    release_state.add_argument("--release-json", type=Path)
    for command in (release_record, release_state):
        command.add_argument("--tag", required=True)
        command.add_argument("--title", required=True)
        command.add_argument("--body", type=Path, required=True)
        command.add_argument("--manifest", type=Path, required=True)
        command.add_argument("--plugin-digest", required=True)

    manifest = commands.add_parser("release-manifest")
    manifest.add_argument("--output", type=Path, required=True)
    manifest_record = commands.add_parser("manifest-record")
    manifest_record.add_argument("--manifest", type=Path, required=True)
    notes = commands.add_parser("release-notes")
    notes.add_argument("--manifest", type=Path, required=True)
    notes.add_argument("--output", type=Path, required=True)
    for command in (manifest, manifest_record, notes):
        command.add_argument("--repository", required=True)
        command.add_argument("--source-sha", required=True)
        command.add_argument("--main-run-id", type=int, required=True)
        command.add_argument("--version", required=True)
        command.add_argument("--image", required=True)
        command.add_argument("--image-digest", required=True)
        command.add_argument("--chart", required=True)
        command.add_argument("--chart-digest", required=True)
        command.add_argument("--plugin-digest", required=True)

    artifact = commands.add_parser("artifact-state")
    artifact.add_argument("--present", choices=("true", "false"), required=True)
    artifact.add_argument("--source-match", choices=("true", "false"), required=True)
    artifact.add_argument("--signature-match", choices=("true", "false"), required=True)

    registry = commands.add_parser("registry-state")
    registry.add_argument("--http-status", type=int, required=True)

    embed = commands.add_parser("chart-digest-embed")
    assert_digest = commands.add_parser("chart-digest-assert")
    for command in (embed, assert_digest):
        command.add_argument("--values", type=Path, required=True)
        command.add_argument("--digest", required=True)
    return parser


def _manifest_arguments(args: argparse.Namespace) -> dict:
    return {
        "repository": args.repository,
        "source_sha": args.source_sha,
        "main_run_id": args.main_run_id,
        "version": args.version,
        "image": args.image,
        "image_digest": args.image_digest,
        "chart": args.chart,
        "chart_digest": args.chart_digest,
        "plugin_digest": args.plugin_digest,
    }


def main(argv: list[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    try:
        if args.command == "transition":
            print(
                json.dumps(
                    classify_transition(
                        args.repository, args.base, args.head, first_parent=args.first_parent
                    ),
                    sort_keys=True,
                )
            )
        elif args.command == "release-window":
            window = discover_transition_window(args.repository, args.head)
            print(
                json.dumps(
                    {
                        "base_sha": window.base_sha,
                        "source_sha": window.intent.source_sha,
                        "version": str(window.intent.version),
                        "tag": window.intent.tag,
                    },
                    sort_keys=True,
                )
            )
        elif args.command == "workflow-run":
            print(
                plan_workflow_run(
                    json.loads(args.event.read_text(encoding="utf-8")), args.repository
                )
            )
        elif args.command == "main-run-record":
            print(
                validate_main_run_record(
                    _read_object(args.run_json),
                    expected_repository=args.repository,
                    expected_run_id=args.run_id,
                    expected_source_sha=args.source_sha,
                )
            )
        elif args.command == "main-jobs-record":
            print(
                validate_main_jobs_record(
                    _read_object(args.jobs_json),
                    expected_run_id=args.run_id,
                    expected_source_sha=args.source_sha,
                )
            )
        elif args.command == "codeql-run-record":
            run_id = classify_codeql_run_record(
                _read_object(args.runs_json),
                expected_repository=args.repository,
                expected_source_sha=args.source_sha,
            )
            print("pending" if run_id is None else run_id)
        elif args.command == "codeql-jobs-record":
            print(
                validate_codeql_jobs_record(
                    _read_object(args.jobs_json),
                    expected_run_id=args.run_id,
                    expected_source_sha=args.source_sha,
                )
            )
        elif args.command == "publisher":
            _emit(
                validate_publisher(
                    args.root,
                    args.source_sha,
                    args.checkout_sha,
                    args.ref,
                    args.event_name,
                    args.repository,
                    args.workflow_ref,
                    args.image,
                    args.chart,
                )
            )
        elif args.command == "settings-receipt":
            validate_settings_receipt(_read_object(args.receipt), args.repository)
            print("exact")
        elif args.command == "settings-preflight":
            print(json.dumps(observe_live_settings(args.repository), indent=2, sort_keys=True))
        elif args.command in {"tag-record", "tag-state"}:
            expected = {
                "tag": args.tag,
                "source_sha": args.source_sha,
                "message": args.message,
                "tagger_name": args.tagger_name,
                "tagger_email": args.tagger_email,
                "tagger_date": args.tagger_date,
            }
            if args.command == "tag-record":
                validate_tag_record(
                    _read_object(args.ref_json), _read_object(args.tag_json), **expected
                )
                print("exact")
            else:
                state = classify_tag_state(
                    args.http_status,
                    _read_object(args.ref_json) if args.ref_json else None,
                    _read_object(args.tag_json) if args.tag_json else None,
                    **expected,
                )
                print(require_publication_state(state, args.require) if args.require else state)
        elif args.command in {"release-record", "release-state"}:
            expected = {
                "tag": args.tag,
                "title": args.title,
                "body": args.body.read_text(encoding="utf-8"),
                "manifest": args.manifest.read_bytes(),
                "plugin_digest": args.plugin_digest,
            }
            if args.command == "release-record":
                validate_release_record(_read_object(args.release_json), **expected)
                print("exact")
            else:
                state = classify_release_state(
                    args.http_status,
                    _read_object(args.release_json) if args.release_json else None,
                    **expected,
                )
                print(require_publication_state(state, args.require) if args.require else state)
        elif args.command in {"release-manifest", "manifest-record", "release-notes"}:
            expected_manifest = build_release_manifest(**_manifest_arguments(args))
            if args.command == "release-manifest":
                args.output.write_bytes(_canonical_json(expected_manifest))
            else:
                validate_release_manifest_record(
                    _read_object(args.manifest), **_manifest_arguments(args)
                )
                if args.command == "release-notes":
                    args.output.write_text(
                        build_release_notes(expected_manifest), encoding="utf-8"
                    )
                else:
                    print("exact")
        elif args.command == "artifact-state":
            state = classify_artifact(
                present=args.present == "true",
                source_match=args.source_match == "true",
                signature_match=args.signature_match == "true",
            )
            print(state)
            if state == "burned":
                return 1
        elif args.command == "registry-state":
            print(classify_registry_response(args.http_status))
        elif args.command == "chart-digest-embed":
            args.values.write_text(
                embed_chart_image_digest(args.values.read_text(encoding="utf-8"), args.digest),
                encoding="utf-8",
            )
            print("embedded")
        elif args.command == "chart-digest-assert":
            assert_chart_image_digest(args.values.read_text(encoding="utf-8"), args.digest)
            print("exact")
        else:  # pragma: no cover - argparse owns this path
            raise ContractError("unknown command")
    except (ContractError, OSError, json.JSONDecodeError, UnicodeDecodeError) as exc:
        print(f"DENY: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
