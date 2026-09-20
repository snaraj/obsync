"""Hostile tests for the `versions.json` follower, plus the real tree.

The module's job is to REFUSE, so most of this file feeds it a ledger that is
wrong in one specific way and requires each one to deny. The last class reads
the repository's OWN `versions.json` and `manifest.json`, which is what makes
this a gate rather than a unit test: the `security` job and `make check` both
run this suite, so a head whose ledger contradicts its manifest cannot reach
`main` and therefore cannot be published.
"""

from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import versions_json as versions  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]

LEDGER = {"0.1.11": "1.7.0", "0.1.13": "1.7.2", "0.1.14": "1.12.4"}
MANIFEST = {
    "id": "obsync-private-sync",
    "name": "Self Hosted Private Sync",
    "version": "0.1.14",
    "minAppVersion": "1.12.4",
    "isDesktopOnly": False,
}


def ledger(**changes: object) -> str:
    return json.dumps({**LEDGER, **changes})


def manifest(**changes: object) -> str:
    return json.dumps({**MANIFEST, **changes})


class AWellFormedLedger(unittest.TestCase):
    def test_a_ledger_covering_the_head_resolves(self):
        # The vacuity probe for everything below: if this ever stops passing,
        # the refusals underneath are proving nothing about a real file.
        self.assertEqual(versions.validate_versions(ledger(), manifest()), LEDGER)

    def test_a_gap_for_an_unpublished_version_is_admissible(self):
        # 0.1.15 was built but never released, so a row for it would promise
        # the installer a download that does not exist. The subject is that
        # the call does NOT raise over a ledger whose gap IS 0.1.15, and the
        # returned rows are the proof that the gap was accepted rather than
        # quietly filled in.
        resolved = versions.validate_versions(
            json.dumps({"0.1.14": "1.7.2", "0.1.16": "1.12.4"}),
            manifest(version="0.1.16"),
        )
        self.assertEqual(resolved, {"0.1.14": "1.7.2", "0.1.16": "1.12.4"})


class TheLedgerShape(unittest.TestCase):
    def test_a_document_that_is_not_a_populated_object_is_refused(self):
        # Each case asserts the refusal it names. `{}` is the reason: "no entry
        # for the head version" would refuse an empty ledger too, so a bare
        # assertRaises cannot tell the emptiness guard from decoration, and
        # deleting that guard would leave this test green.
        for text, refusal in (
            ("{not json", "versions.json is not valid JSON"),
            ("[]", "must be a JSON object"),
            ('"0.1.14"', "must be a JSON object"),
            ("null", "must be a JSON object"),
            ("{}", "empty"),
        ):
            with self.subTest(text=text):
                with self.assertRaisesRegex(versions.VersionsError, refusal):
                    versions.validate_versions(text, manifest())

    def test_a_duplicated_key_is_refused_rather_than_silently_last_wins(self):
        # `json.loads` keeps the LAST of two identical keys, so this file
        # would otherwise validate against one floor and install the other.
        text = '{"0.1.11": "1.7.0", "0.1.14": "1.12.4", "0.1.14": "1.7.0"}'
        self.assertEqual(json.loads(text)["0.1.14"], "1.7.0", "the shape being defended against")
        with self.assertRaisesRegex(versions.VersionsError, "twice"):
            versions.validate_versions(text, manifest())

    def test_a_key_or_a_floor_that_is_not_a_bare_version_is_refused(self):
        # Every case here names the SHAPE rule, so every case asserts that
        # refusal rather than any refusal: with a bare assertRaises, relaxing
        # SEMVER_RE to make the third component optional left this suite green
        # because the ordering check and the head-floor comparison answered
        # first. The last two cases exist because no other guard CAN answer
        # them -- a two-part key placed FIRST has no predecessor to be
        # compared against, and a two-part floor on a row that is not the head
        # is never compared with the manifest -- so the shape rule is the only
        # verdict available for either one.
        def appended(mutation):
            # A new key lands LAST in insertion order; an existing one keeps
            # its place, which is what separates the two groups below.
            return json.dumps({**LEDGER, **mutation})

        for label, text in (
            ("prefixed key", appended({"v0.1.14": "1.12.4"})),
            ("two-part key, last", appended({"0.1": "1.12.4"})),
            ("prefixed floor", appended({"0.1.14": "v1.12.4"})),
            ("two-part floor on the head row", appended({"0.1.14": "1.12"})),
            ("pre-release floor", appended({"0.1.14": "1.12.4-beta"})),
            ("numeric floor", appended({"0.1.14": 1})),
            ("null floor", appended({"0.1.14": None})),
            ("two-part key, first", json.dumps(
                {"0.1": "1.7.0", "0.1.13": "1.7.2", "0.1.14": "1.12.4"})),
            ("two-part floor on an older row", json.dumps(
                {"0.1.11": "1.7", "0.1.13": "1.7.2", "0.1.14": "1.12.4"})),
        ):
            with self.subTest(refusal=label):
                with self.assertRaisesRegex(versions.VersionsError, "bare X.Y.Z"):
                    versions.validate_versions(text, manifest())

    def test_keys_out_of_ascending_order_are_refused(self):
        # String order puts 0.1.9 after 0.1.10; precedence does not, and the
        # ledger is read top to bottom by people.
        text = json.dumps({"0.1.11": "1.7.0", "0.1.9": "1.7.0", "0.1.14": "1.12.4"})
        with self.assertRaisesRegex(versions.VersionsError, "ascending"):
            versions.validate_versions(text, manifest())

    def test_a_row_above_the_head_is_refused(self):
        for above in ("0.1.15", "0.2.0", "1.0.0"):
            with self.subTest(above=above):
                with self.assertRaisesRegex(versions.VersionsError, "above the released head"):
                    versions.validate_versions(ledger(**{above: "1.12.4"}), manifest())


class TheHeadRow(unittest.TestCase):
    def test_a_ledger_that_does_not_name_the_head_is_refused(self):
        text = json.dumps({"0.1.11": "1.7.0", "0.1.13": "1.7.2"})
        with self.assertRaisesRegex(versions.VersionsError, "no entry for the head"):
            versions.validate_versions(text, manifest())

    def test_a_head_row_that_contradicts_the_manifest_floor_is_refused(self):
        with self.assertRaisesRegex(versions.VersionsError, "minAppVersion"):
            versions.validate_versions(ledger(**{"0.1.14": "1.7.2"}), manifest())

    def test_an_unreadable_manifest_refuses_before_the_ledger_is_judged(self):
        # The floor's own shape check is why these assert their message: a
        # ledger VALUE must already be bare, so `ledger[head] != floor` would
        # refuse a manifest floor of "1.12" for the wrong reason and deleting
        # the manifest-side check would leave this test green.
        for text, refusal in (
            ("{not json", "manifest.json is not valid JSON"),
            ("[]", "manifest.json must be a JSON object"),
            (json.dumps({"version": "0.1.14"}), "minAppVersion must be a bare"),
            (json.dumps({"minAppVersion": "1.12.4"}), "version must be a bare"),
            (json.dumps({**MANIFEST, "version": "v0.1.14"}), "version must be a bare"),
            (json.dumps({**MANIFEST, "minAppVersion": "1.12"}), "minAppVersion must be a bare"),
        ):
            with self.subTest(manifest=text[:32]):
                with self.assertRaisesRegex(versions.VersionsError, refusal):
                    versions.validate_versions(ledger(), text)


class TheRepositoryLedger(unittest.TestCase):
    """The gate: this repository's own two files, at the head being gated."""

    def test_the_committed_ledger_covers_this_head(self):
        resolved = versions.validate_versions(
            (ROOT / "versions.json").read_text(encoding="utf-8"),
            (ROOT / "manifest.json").read_text(encoding="utf-8"),
        )
        head = json.loads((ROOT / "manifest.json").read_text(encoding="utf-8"))["version"]
        self.assertEqual(resolved[head], json.loads(
            (ROOT / "manifest.json").read_text(encoding="utf-8"))["minAppVersion"])
        self.assertEqual(list(resolved)[-1], head, "the head is the newest row")

    def test_every_recorded_floor_is_one_this_plugin_actually_declared(self):
        # The four floors this plugin has published, read from the releases'
        # own manifests: 1.7.0 (0.1.11-0.1.12), 1.7.2 (0.1.13-0.1.14),
        # 1.12.4 (0.1.16-1.0.1), 1.13.0 (1.0.2 onwards). A row carrying
        # anything else is a typo nobody would see until an install failed.
        resolved = versions.validate_versions(
            (ROOT / "versions.json").read_text(encoding="utf-8"),
            (ROOT / "manifest.json").read_text(encoding="utf-8"),
        )
        self.assertEqual(set(resolved.values()) - {"1.7.0", "1.7.2", "1.12.4", "1.13.0"}, set())


if __name__ == "__main__":
    unittest.main()
