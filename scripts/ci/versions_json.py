#!/usr/bin/env python3
"""The eighth follower: root `versions.json`, held against `manifest.json`.

WHY THIS FILE EXISTS AT ALL. Obsidian's community-plugin installer reads
`versions.json` from the default branch of the registered repository and uses
it to decide WHICH release a given Obsidian version may install: the newest
plugin version whose recorded `minAppVersion` the app satisfies. Without the
file the installer has only the newest release's own `minAppVersion`, so an
Obsidian older than that floor is offered nothing at all rather than the last
release it could actually run. This plugin's floor moved twice already --
1.7.0 at 0.1.11, 1.7.2 at 0.1.13, 1.12.4 at 0.1.16 -- so the ledger is the
difference between an older Obsidian installing 0.1.14 and installing nothing.

IT IS A FOLLOWER, NOT A LOCK. The seven lockstep locks (`docs/release.md`) are
one version in six files, walked per commit by `release_contract.py`. This
file is a LEDGER: it accumulates one line per published version and its rows
for older versions must NOT move when the head advances. So it is held here,
beside `plugin/package.json` and `Cargo.lock`, by a gate rather than by the
classifier -- and what the gate pins is the head row plus the shape of the
ledger, never a version number repeated an eighth time.

WHAT IS REFUSED, and each of these is a way the file goes silently wrong:

  * not one JSON object, or an empty one -- an installer reading `[]` or `{}`
    learns nothing and falls back without saying so;
  * a duplicate key -- `json.loads` keeps the LAST of two identical keys, so a
    file that says two different floors for one version would validate here
    and install the other one;
  * a key or a value that is not a bare `X.Y.Z` -- `v0.1.19`, `0.1`, and
    `1.12.4-beta` are all things the installer will not match;
  * keys out of ascending SemVer order -- the ledger is read by people, and
    `0.1.9` sorting after `0.1.10` as strings is exactly the mistake this
    catches;
  * a key ABOVE the head version -- a row for a version that was never
    released promises the installer a download that does not exist;
  * a missing head row, or a head row whose floor is not the one root
    `manifest.json` declares -- the release being cut would ship a floor the
    ledger contradicts.

Standard library only (requirement 5). The decision lives here and the test
beside it calls the same function CI calls, so it cannot drift into prose.
"""

from __future__ import annotations

import json
import re
from typing import Mapping

SEMVER_RE = re.compile(r"^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$")


class VersionsError(ValueError):
    """Every refusal in this module. Never caught to continue."""


def _semver(raw: object, field: str) -> tuple[int, int, int]:
    if not isinstance(raw, str) or not SEMVER_RE.fullmatch(raw):
        raise VersionsError(f"{field} must be a bare X.Y.Z version, not {raw!r}")
    return tuple(int(part) for part in raw.split("."))  # type: ignore[return-value]


def _no_duplicate_keys(pairs: list[tuple[str, object]]) -> dict[str, object]:
    seen: dict[str, object] = {}
    for key, value in pairs:
        if key in seen:
            raise VersionsError(f"versions.json names {key!r} twice")
        seen[key] = value
    return seen


def read_manifest(text: str) -> tuple[str, tuple[int, int, int], str]:
    """The head version, parsed, and the floor it declares, from the manifest."""
    try:
        manifest = json.loads(text)
    except json.JSONDecodeError as exc:
        raise VersionsError("manifest.json is not valid JSON") from exc
    if not isinstance(manifest, Mapping):
        raise VersionsError("manifest.json must be a JSON object")
    version = manifest.get("version")
    floor = manifest.get("minAppVersion")
    parsed = _semver(version, "manifest.json version")
    _semver(floor, "manifest.json minAppVersion")
    return str(version), parsed, str(floor)


def validate_versions(versions_text: str, manifest_text: str) -> dict[str, str]:
    """Prove the ledger is well formed and covers exactly this head."""
    head, head_version, floor = read_manifest(manifest_text)
    try:
        ledger = json.loads(versions_text, object_pairs_hook=_no_duplicate_keys)
    except json.JSONDecodeError as exc:
        raise VersionsError("versions.json is not valid JSON") from exc
    if not isinstance(ledger, dict):
        raise VersionsError("versions.json must be a JSON object of version -> minAppVersion")
    if not ledger:
        raise VersionsError("versions.json is empty; it must record every published version")

    previous: tuple[int, int, int] | None = None
    for key, value in ledger.items():
        parsed = _semver(key, "versions.json key")
        _semver(value, f"versions.json[{key}]")
        if previous is not None and parsed <= previous:
            raise VersionsError(
                f"versions.json is not in ascending version order: {key} follows "
                f"{'.'.join(str(part) for part in previous)}"
            )
        if parsed > head_version:
            raise VersionsError(
                f"versions.json names {key}, above the released head {head}"
            )
        previous = parsed

    if head not in ledger:
        raise VersionsError(f"versions.json has no entry for the head version {head}")
    if ledger[head] != floor:
        raise VersionsError(
            f"versions.json[{head}] is {ledger[head]!r}, not manifest.json's "
            f"minAppVersion {floor!r}"
        )
    return {key: str(value) for key, value in ledger.items()}
