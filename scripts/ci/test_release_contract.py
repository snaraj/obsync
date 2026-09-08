"""Hostile tests for the release contract.

The contract's job is to REFUSE, so most of this suite builds real git
histories and real GitHub REST records that are wrong in one specific way and
requires each one to deny. The seven locks, the two-verdict classifier, the
publication state machines, and the governance receipt are each exercised from
the outside, through the same functions CI calls.

Every history here is built with `git` in a temporary directory, because the
classifier's whole argument rests on what git reports about a range -- a fake
that returned lists of paths would be testing the test.
"""

from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import release_contract as contract  # noqa: E402

SENTINEL = contract.CHART_DIGEST_SENTINEL
IMAGE_DIGEST = "sha256:" + "1" * 64
CHART_DIGEST = "sha256:" + "2" * 64
PLUGIN_DIGEST = "sha256:" + "3" * 64
REPOSITORY = contract.EXPECTED_REPOSITORY
IMAGE = contract.EXPECTED_IMAGE
CHART = contract.EXPECTED_CHART


def workflow(name: str) -> dict:
    """One `.github/workflows` file, resolved structurally by `miniyaml`.

    Never a line match: the whole point of reading the workflow here is that a
    job the publisher authorizes against must be a job GitHub will actually
    run, and a reader that refuses what it cannot model is the only way to say
    that about YAML.
    """
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    import miniyaml  # noqa: PLC0415

    root = Path(__file__).resolve().parents[2]
    return miniyaml.load_one((root / ".github" / "workflows" / name).read_text(encoding="utf-8"))


def locks(version: str, history: list[str] | None = None) -> dict[str, str]:
    """One consistent snapshot of all six lock files at `version`."""
    entries = [version] + list(history or [])
    changelog = "# Changelog\n\n" + "".join(
        f"## {entry} - {'Unreleased' if entry == version else '2026-01-01'}\n\n"
        f"### Added\n\n- Entry for {entry}.\n\n"
        for entry in entries
    )
    return {
        "VERSION": f"{version}\n",
        "Cargo.toml": (
            "[workspace]\nresolver = \"3\"\nmembers = []\n\n"
            f"[workspace.package]\nversion = \"{version}\"\nedition = \"2024\"\n"
        ),
        "chart/Chart.yaml": (
            f"apiVersion: v2\nname: obsync\nversion: {version}\nappVersion: \"{version}\"\n"
        ),
        "chart/values.yaml": (
            "image:\n  repository: ghcr.io/snaraj/obsync\n"
            f"  tag: v{version}\n  digest: {SENTINEL}\n"
        ),
        "plugin/manifest.json": json.dumps({"id": "obsync", "version": version}) + "\n",
        "CHANGELOG.md": changelog,
    }


class Repository:
    """A real git repository with a real, linear, first-parent history."""

    ENVIRONMENT = {
        "GIT_AUTHOR_NAME": "Samuel Naranjo",
        "GIT_AUTHOR_EMAIL": "39077795+snaraj@users.noreply.github.com",
        "GIT_COMMITTER_NAME": "Samuel Naranjo",
        "GIT_COMMITTER_EMAIL": "39077795+snaraj@users.noreply.github.com",
        "GIT_AUTHOR_DATE": "2026-09-07T00:00:00+00:00",
        "GIT_COMMITTER_DATE": "2026-09-07T00:00:00+00:00",
        "PATH": "/usr/bin:/bin:/usr/local/bin",
    }

    def __init__(self, root: Path) -> None:
        self.root = root
        self.git("init", "-q", "-b", "main")

    def git(self, *args: str) -> str:
        completed = subprocess.run(
            ["git", "-C", str(self.root), *args],
            check=True,
            capture_output=True,
            text=True,
            env={**self.ENVIRONMENT, "HOME": str(self.root)},
        )
        return completed.stdout.strip()

    def write(self, files: dict[str, str]) -> None:
        for name, content in files.items():
            path = self.root / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(content, encoding="utf-8")

    def commit(self, files: dict[str, str], message: str = "commit") -> str:
        self.write(files)
        self.git("add", "-A")
        self.git("commit", "-q", "-m", f"{message}\n\n- Opus5")
        return self.git("rev-parse", "HEAD")


class GitFixture(unittest.TestCase):
    def setUp(self) -> None:
        self._directory = tempfile.TemporaryDirectory()
        self.addCleanup(self._directory.cleanup)
        self.repository = Repository(Path(self._directory.name))
        self.root = self.repository.root
        self.base = self.repository.commit(
            {**locks("0.1.0"), "README.md": "readme\n", "src.rs": "fn main() {}\n"},
            "base",
        )

    def classify(self, base: str, head: str, first_parent: bool = False) -> dict:
        return contract.classify_transition(
            self.root, base, head, first_parent=first_parent
        )


class TheSevenLocks(unittest.TestCase):
    def test_a_consistent_snapshot_resolves_its_version(self):
        intent = contract.validate_snapshot(locks("0.1.4"))
        self.assertEqual(str(intent.version), "0.1.4")
        self.assertEqual(intent.tag, "v0.1.4")

    def test_each_lock_disagreeing_alone_is_refused(self):
        mutations = {
            "VERSION": {"VERSION": "0.1.5\n"},
            "Cargo.toml": {
                "Cargo.toml": "[workspace]\nmembers = []\n\n[workspace.package]\nversion = \"0.1.5\"\n"
            },
            "chart version": {
                "chart/Chart.yaml": "apiVersion: v2\nname: obsync\nversion: 0.1.5\nappVersion: \"0.1.4\"\n"
            },
            "chart appVersion": {
                "chart/Chart.yaml": "apiVersion: v2\nname: obsync\nversion: 0.1.4\nappVersion: \"0.1.5\"\n"
            },
            "image tag prefix": {
                "chart/values.yaml": (
                    "image:\n  repository: ghcr.io/snaraj/obsync\n"
                    f"  tag: x0.1.4\n  digest: {SENTINEL}\n"
                )
            },
            "image tag": {
                "chart/values.yaml": (
                    "image:\n  repository: ghcr.io/snaraj/obsync\n"
                    f"  tag: v0.1.5\n  digest: {SENTINEL}\n"
                )
            },
            "plugin manifest": {"plugin/manifest.json": '{"id": "obsync", "version": "0.1.5"}\n'},
            "changelog": {"CHANGELOG.md": "# Changelog\n\n## 0.1.5 - Unreleased\n\n- x\n"},
        }
        for lock, mutation in mutations.items():
            with self.subTest(lock=lock):
                with self.assertRaises(contract.ContractError):
                    contract.validate_snapshot({**locks("0.1.4"), **mutation})

    def test_a_missing_lock_file_is_refused(self):
        for missing in contract.RELEASE_LOCK_PATHS:
            with self.subTest(missing=missing):
                snapshot = locks("0.1.4")
                del snapshot[missing]
                with self.assertRaises(contract.ContractError):
                    contract.validate_snapshot(snapshot)

    def test_a_malformed_lock_file_is_refused_rather_than_ignored(self):
        for mutation in (
            {"Cargo.toml": "this is not toml ==="},
            {"Cargo.toml": "[workspace]\nmembers = []\n"},
            {"plugin/manifest.json": "{not json"},
            {"plugin/manifest.json": '{"id": "obsync"}'},
            {"chart/values.yaml": "image:\n  tag: v0.1.4\nimage:\n  tag: v0.1.4\n"},
        ):
            with self.subTest(mutation=sorted(mutation)):
                with self.assertRaises(contract.ContractError):
                    contract.validate_snapshot({**locks("0.1.4"), **mutation})


class TheNextPatchBackstop(unittest.TestCase):
    """A backstop the range walk reaches only after the mainline check passes.

    `_monotonic_transitions` refuses a skipped patch first, so this guard is
    never the one that reddens a real range -- which is exactly why it is
    exercised directly here. A backstop nothing can turn red is decoration, and
    decoration next to real checks teaches a reader to trust the wrong thing.
    """

    def test_only_the_exact_next_patch_is_accepted(self):
        base = contract.Version.parse("0.1.4")
        contract.require_next_patch(base, contract.Version.parse("0.1.5"))
        for head in ("0.1.4", "0.1.6", "0.2.0", "1.0.0", "0.1.3"):
            with self.subTest(head=head):
                with self.assertRaises(contract.ContractError):
                    contract.require_next_patch(base, contract.Version.parse(head))

    def test_versions_order_by_precedence_not_by_string(self):
        self.assertLess(contract.Version.parse("0.1.9"), contract.Version.parse("0.1.10"))
        self.assertLess(contract.Version.parse("0.9.0"), contract.Version.parse("0.10.0"))


class TheChangelogLadder(unittest.TestCase):
    def test_a_descending_ladder_resolves(self):
        headings = contract.parse_changelog(locks("0.1.4", ["0.1.3", "0.1.2"])["CHANGELOG.md"])
        self.assertEqual([str(version) for version, _stamp in headings], ["0.1.4", "0.1.3", "0.1.2"])

    def test_an_out_of_order_or_duplicated_ladder_is_refused(self):
        for changelog in (
            "## 0.1.2 - 2026-01-01\n\n## 0.1.4 - 2026-01-02\n",
            "## 0.1.4 - 2026-01-01\n\n## 0.1.4 - 2026-01-02\n",
        ):
            with self.subTest(changelog=changelog.splitlines()[0]):
                with self.assertRaises(contract.ContractError):
                    contract.parse_changelog(changelog)

    def test_a_bad_heading_or_date_is_refused(self):
        for changelog in (
            "## v0.1.4 - 2026-01-01\n",
            "## 0.1.4 - Sometime\n",
            "## 0.1.4 - 2026-13-45\n",
            "# Changelog\n\nno headings here\n",
        ):
            with self.subTest(changelog=changelog.splitlines()[-1]):
                with self.assertRaises(contract.ContractError):
                    contract.parse_changelog(changelog)

    def test_released_history_is_append_only(self):
        base = locks("0.1.3", ["0.1.2"])["CHANGELOG.md"]
        kept = locks("0.1.4", ["0.1.3", "0.1.2"])["CHANGELOG.md"]
        dropped = locks("0.1.4", ["0.1.3"])["CHANGELOG.md"]
        contract.require_appended_changelog(base, kept)
        with self.assertRaises(contract.ContractError):
            contract.require_appended_changelog(base, dropped)


class TheClassifier(GitFixture):
    def test_a_documentation_only_range_classifies_no_artifact(self):
        head = self.repository.commit(
            {"README.md": "changed\n", "docs/design.md": "notes\n", ".gitignore": "/target/\n"},
            "docs",
        )
        verdict = self.classify(self.base, head)
        self.assertEqual(verdict["class"], "no-artifact")
        self.assertEqual(verdict["version"], "0.1.0")
        self.assertEqual(verdict["commits"], 1)

    def test_a_code_change_with_one_exact_patch_classifies_artifact(self):
        head = self.repository.commit(
            {**locks("0.1.1", ["0.1.0"]), "src.rs": "fn main() { }\n"}, "feature"
        )
        verdict = self.classify(self.base, head)
        self.assertEqual(verdict["class"], "artifact")
        self.assertEqual(verdict["tag"], "v0.1.1")

    def test_a_code_change_with_an_unchanged_version_denies(self):
        head = self.repository.commit({"src.rs": "fn main() { /* edited */ }\n"}, "unversioned")
        with self.assertRaises(contract.ContractError):
            self.classify(self.base, head)

    def test_a_documentation_range_that_touches_a_lock_denies(self):
        # CHANGELOG.md and VERSION sit OUTSIDE the documentation allowlist
        # precisely so a no-release range can never claim one.
        head = self.repository.commit({"CHANGELOG.md": "# Changelog\n\n## 0.1.0 - Unreleased\n"}, "x")
        with self.assertRaises(contract.ContractError):
            self.classify(self.base, head)

    def test_a_non_markdown_file_under_docs_is_not_documentation(self):
        head = self.repository.commit({"docs/diagram.svg": "<svg/>\n"}, "asset")
        with self.assertRaises(contract.ContractError):
            self.classify(self.base, head)
        self.assertFalse(contract.is_documentation_path("docs/diagram.svg"))
        self.assertFalse(contract.is_documentation_path("nested/AGENTS.md"))
        self.assertTrue(contract.is_documentation_path("docs/nested/deep.md"))

    def test_a_skipped_or_reverted_patch_denies(self):
        skipped = self.repository.commit({**locks("0.1.3", ["0.1.0"]), "src.rs": "x\n"}, "skip")
        with self.assertRaises(contract.ContractError):
            self.classify(self.base, skipped)

    def test_two_patch_boundaries_in_one_range_deny(self):
        first = self.repository.commit({**locks("0.1.1", ["0.1.0"]), "src.rs": "a\n"}, "one")
        second = self.repository.commit(
            {**locks("0.1.2", ["0.1.1", "0.1.0"]), "src.rs": "b\n"}, "two"
        )
        self.assertEqual(self.classify(self.base, first)["tag"], "v0.1.1")
        with self.assertRaises(contract.ContractError) as refusal:
            self.classify(self.base, second)
        # The message matters, and not for tidiness: "exactly one patch
        # boundary" tells an author their RANGE spans two releases, where the
        # next-patch backstop underneath would only say the head version is
        # wrong -- and would send them to change the version rather than to
        # re-cut the branch.
        self.assertIn("exactly one patch boundary", str(refusal.exception))

    def test_a_multi_commit_rebase_range_is_one_release(self):
        # A squash merge is one commit; an allowed rebase merge installs
        # several. The final tree is one release intent either way.
        self.repository.commit({"src.rs": "step one\n", **locks("0.1.1", ["0.1.0"])}, "bump")
        head = self.repository.commit({"src.rs": "step two\n"}, "follow-up")
        verdict = self.classify(self.base, head)
        self.assertEqual((verdict["class"], verdict["tag"]), ("artifact", "v0.1.1"))

    def test_an_unresolvable_or_reversed_range_denies(self):
        head = self.repository.commit({"README.md": "x\n"}, "docs")
        for base, target in ((head, self.base), ("0" * 40, head), (self.base, "z" * 40)):
            with self.subTest(base=base[:8]):
                with self.assertRaises(contract.ContractError):
                    self.classify(base, target)

    def test_the_release_window_recovers_the_last_boundary(self):
        head = self.repository.commit({**locks("0.1.1", ["0.1.0"]), "src.rs": "a\n"}, "bump")
        window = contract.discover_transition_window(self.root, head)
        self.assertEqual(window.base_sha, self.base)
        self.assertEqual(window.intent.tag, "v0.1.1")

    def test_first_parent_cross_checks_the_whole_mainline_not_only_the_range(self):
        # A range can look perfect while the history UNDER it is broken. Here
        # 0.1.0 -> 0.1.2 skips a patch outside the measured range; the range
        # 0.1.2 -> 0.1.3 is itself one clean boundary. Without the mainline
        # cross-check that publishes; with it, the push denies.
        skipped = self.repository.commit({**locks("0.1.2", ["0.1.0"]), "src.rs": "a\n"}, "skip")
        head = self.repository.commit(
            {**locks("0.1.3", ["0.1.2", "0.1.0"]), "src.rs": "b\n"}, "next"
        )
        self.assertEqual(self.classify(skipped, head)["tag"], "v0.1.3")
        with self.assertRaises(contract.ContractError):
            self.classify(skipped, head, first_parent=True)

    def test_first_parent_accepts_a_range_whose_mainline_is_sound(self):
        first = self.repository.commit({**locks("0.1.1", ["0.1.0"]), "src.rs": "a\n"}, "one")
        second = self.repository.commit(
            {**locks("0.1.2", ["0.1.1", "0.1.0"]), "src.rs": "b\n"}, "two"
        )
        self.assertEqual(self.classify(first, second, first_parent=True)["tag"], "v0.1.2")


class GenesisFixture(unittest.TestCase):
    """A repository born the way GitHub creates one: README.md and LICENSE."""

    def setUp(self) -> None:
        self._directory = tempfile.TemporaryDirectory()
        self.addCleanup(self._directory.cleanup)
        self.repository = Repository(Path(self._directory.name))
        self.root = self.repository.root
        self.base = self.repository.commit(
            {"README.md": "# obsync\n", "LICENSE": "MIT\n"}, "Initial commit"
        )

    def classify(self, head: str, first_parent: bool = False) -> dict:
        return contract.classify_transition(
            self.root, self.base, head, first_parent=first_parent
        )


class TheGenesisRange(GenesisFixture):
    def test_the_root_commit_carries_no_release_lock(self):
        # The premise. If this ever stops holding the rule below is dead code.
        self.assertEqual(contract._locks_present(self.root, self.base), set())

    def test_a_complete_first_release_classifies_artifact(self):
        head = self.repository.commit(
            {**locks("0.1.0"), "crates/obsyncd/src/main.rs": "fn main() {}\n"}, "bootstrap"
        )
        verdict = self.classify(head)
        self.assertEqual(verdict["class"], "artifact")
        self.assertEqual(verdict["tag"], "v0.1.0")
        self.assertEqual(verdict["base_sha"], self.base)
        self.assertEqual(verdict["source_sha"], head)

    def test_the_post_merge_classification_agrees(self):
        # release-after-main re-derives with --first-parent, so v0.1.0 only
        # gets its Release if the genesis rule survives that path too.
        head = self.repository.commit({**locks("0.1.0"), "src.rs": "fn main() {}\n"}, "bootstrap")
        self.assertEqual(self.classify(head, first_parent=True)["tag"], "v0.1.0")

    def test_the_publisher_can_recover_the_genesis_window(self):
        # `release-window` binds the version and tag the publisher tags with.
        # Without a genesis boundary in the mainline it denies v0.1.0 forever.
        head = self.repository.commit({**locks("0.1.0"), "src.rs": "x\n"}, "bootstrap")
        window = contract.discover_transition_window(self.root, head)
        self.assertEqual(window.base_sha, self.base)
        self.assertEqual(window.intent.tag, "v0.1.0")

    def test_a_linear_multi_commit_genesis_range_is_one_release(self):
        # The composed train is a linear chain, so the locks arrive across
        # several commits rather than all at once.
        self.repository.commit({"Cargo.toml": locks("0.1.0")["Cargo.toml"]}, "workspace")
        self.repository.commit(
            {"chart/Chart.yaml": locks("0.1.0")["chart/Chart.yaml"]}, "chart"
        )
        head = self.repository.commit({**locks("0.1.0"), "src.rs": "x\n"}, "the rest")
        self.assertEqual(self.classify(head, first_parent=True)["tag"], "v0.1.0")
        self.assertEqual(
            contract.discover_transition_window(self.root, head).intent.tag, "v0.1.0"
        )

    def test_one_lock_missing_at_head_denies_by_name(self):
        for absent in contract.RELEASE_LOCK_PATHS:
            with self.subTest(absent=absent):
                snapshot = {key: value for key, value in locks("0.1.0").items() if key != absent}
                head = self.repository.commit({**snapshot, "src.rs": "x\n"}, "partial")
                with self.assertRaises(contract.ContractError) as refusal:
                    self.classify(head)
                self.assertIn("genesis range", str(refusal.exception))
                self.assertIn(absent, str(refusal.exception))
                self.repository.git("reset", "-q", "--hard", self.base)
                self.repository.git("clean", "-qfd")

    def test_locks_disagreeing_at_head_deny(self):
        snapshot = {**locks("0.1.0"), "plugin/manifest.json": locks("0.1.1")["plugin/manifest.json"]}
        head = self.repository.commit({**snapshot, "src.rs": "x\n"}, "disagreeing")
        with self.assertRaises(contract.ContractError):
            self.classify(head)

    def test_a_lock_edited_after_it_was_introduced_denies(self):
        # The per-commit walk only ever looks at INTRODUCTIONS, so a lock
        # introduced correctly and then edited later in the range is invisible
        # to it. Only the head snapshot sees that, which is why genesis runs
        # the same validate_snapshot every other range runs rather than
        # trusting its own walk.
        self.repository.commit({**locks("0.1.0"), "src.rs": "a\n"}, "all seven at 0.1.0")
        head = self.repository.commit(
            {"plugin/manifest.json": locks("0.1.1")["plugin/manifest.json"]}, "edit one lock"
        )
        with self.assertRaises(contract.ContractError):
            self.classify(head)

    def test_a_middle_commit_introducing_a_lock_at_another_version_denies(self):
        # The head is perfectly consistent; only the INTRODUCTION disagrees.
        # Without the per-commit check this range would classify artifact.
        self.repository.commit({"VERSION": "0.9.9\n"}, "wrong version first")
        head = self.repository.commit({**locks("0.1.0"), "src.rs": "x\n"}, "reconciled at the tip")
        with self.assertRaises(contract.ContractError) as refusal:
            self.classify(head)
        self.assertIn("genesis range", str(refusal.exception))
        self.assertIn("0.9.9", str(refusal.exception))

    def test_removing_a_lock_inside_the_range_denies(self):
        # A removal is how an author could otherwise dodge the introduction
        # check: introduce at the wrong version, delete, re-introduce.
        self.repository.commit({"VERSION": "0.1.0\n"}, "introduce")
        self.repository.git("rm", "-q", "VERSION")
        self.repository.git("commit", "-q", "-m", "remove\n\n- Opus5")
        head = self.repository.commit({**locks("0.1.0"), "src.rs": "x\n"}, "re-introduce")
        with self.assertRaises(contract.ContractError) as refusal:
            self.classify(head)
        self.assertIn("removes release lock", str(refusal.exception))

    def test_a_documentation_only_range_from_a_lock_less_base_denies(self):
        # Deliberate: a no-artifact verdict here would retain a version that
        # does not exist yet.
        head = self.repository.commit({"docs/design.md": "notes\n"}, "docs")
        with self.assertRaises(contract.ContractError) as refusal:
            self.classify(head)
        self.assertIn("genesis range", str(refusal.exception))

    def test_a_base_carrying_one_lock_takes_the_ordinary_rules(self):
        # Genesis is unreachable the moment main carries a lock. A base with
        # only VERSION is NOT genesis, so it denies exactly as it does today --
        # and the message must be the ordinary one, not the genesis one.
        base = self.repository.commit({"VERSION": "0.1.0\n"}, "only VERSION")
        head = self.repository.commit({"src.rs": "fn main() {}\n"}, "code, no bump")
        with self.assertRaises(contract.ContractError) as refusal:
            contract.classify_transition(self.root, base, head, first_parent=False)
        self.assertNotIn("genesis", str(refusal.exception))
        self.assertIn("without one exact release patch", str(refusal.exception))

    def test_the_second_release_uses_the_ordinary_rules_again(self):
        # The lock-less root is still in the mainline forever, so the genesis
        # boundary must not keep winning: 0.1.1 has to advance from 0.1.0.
        first = self.repository.commit({**locks("0.1.0"), "src.rs": "a\n"}, "bootstrap")
        second = self.repository.commit(
            {**locks("0.1.1", ["0.1.0"]), "src.rs": "b\n"}, "next"
        )
        verdict = contract.classify_transition(
            self.root, first, second, first_parent=True
        )
        self.assertEqual(verdict["tag"], "v0.1.1")
        window = contract.discover_transition_window(self.root, second)
        self.assertEqual((window.base_sha, window.intent.tag), (first, "v0.1.1"))

    def test_a_skipped_patch_after_genesis_still_denies(self):
        self.repository.commit({**locks("0.1.0"), "src.rs": "a\n"}, "bootstrap")
        skipped = self.repository.commit({**locks("0.1.2", ["0.1.0"]), "src.rs": "b\n"}, "skip")
        with self.assertRaises(contract.ContractError):
            contract.discover_transition_window(self.root, skipped)

    def test_walk_genesis_refuses_a_base_that_carries_a_lock(self):
        # Called directly it must not accept what the classifier would never
        # route to it; a helper that trusts its caller is a helper waiting to
        # be called by a second one.
        base = self.repository.commit({"VERSION": "0.1.0\n"}, "only VERSION")
        head = self.repository.commit({**locks("0.1.0"), "src.rs": "x\n"}, "rest")
        with self.assertRaises(contract.ContractError):
            contract.walk_genesis(self.root, base, head, [head])


class ChartDigestSubstitution(unittest.TestCase):
    VALUES = locks("0.1.0")["chart/values.yaml"]

    def test_the_committed_sentinel_is_substituted_exactly_once(self):
        embedded = contract.embed_chart_image_digest(self.VALUES, IMAGE_DIGEST)
        self.assertIn(f"digest: {IMAGE_DIGEST}", embedded)
        self.assertNotIn(SENTINEL, embedded)
        contract.assert_chart_image_digest(embedded, IMAGE_DIGEST)

    def test_substituting_a_second_time_is_refused(self):
        embedded = contract.embed_chart_image_digest(self.VALUES, IMAGE_DIGEST)
        with self.assertRaises(contract.ContractError):
            contract.embed_chart_image_digest(embedded, CHART_DIGEST)

    def test_the_sentinel_can_never_be_the_published_digest(self):
        for digest in (SENTINEL, "sha256:abc", "SHA256:" + "1" * 64, ""):
            with self.subTest(digest=digest[:16]):
                with self.assertRaises(contract.ContractError):
                    contract.embed_chart_image_digest(self.VALUES, digest)

    def test_an_unsubstituted_or_wrong_digest_fails_the_assertion(self):
        with self.assertRaises(contract.ContractError):
            contract.assert_chart_image_digest(self.VALUES, IMAGE_DIGEST)
        embedded = contract.embed_chart_image_digest(self.VALUES, IMAGE_DIGEST)
        with self.assertRaises(contract.ContractError):
            contract.assert_chart_image_digest(embedded, CHART_DIGEST)


def workflow_run_event(**overrides: object) -> dict:
    run = {
        "name": contract.EXPECTED_WORKFLOW,
        "path": contract.EXPECTED_WORKFLOW_PATH,
        "event": "push",
        "status": "completed",
        "conclusion": "success",
        "head_branch": "main",
        "head_sha": "a" * 40,
        "head_repository": {"full_name": REPOSITORY},
    }
    run.update(overrides)
    return {"repository": {"full_name": REPOSITORY}, "workflow_run": run}


def main_run_record(**overrides: object) -> dict:
    record = {
        "id": 42,
        "name": contract.EXPECTED_WORKFLOW,
        "path": contract.EXPECTED_WORKFLOW_PATH,
        "event": "push",
        "status": "completed",
        "conclusion": "success",
        "head_branch": "main",
        "head_sha": "a" * 40,
        "repository": {"full_name": REPOSITORY},
        "head_repository": {"full_name": REPOSITORY},
    }
    record.update(overrides)
    return record


def jobs_record(expected: dict, run_id: int = 42, source_sha: str = "a" * 40) -> dict:
    jobs = [
        {
            "id": index + 1,
            "run_id": run_id,
            "head_sha": source_sha,
            "name": name,
            "status": "completed",
            "conclusion": conclusion,
        }
        for index, (name, conclusion) in enumerate(sorted(expected.items()))
    ]
    return {"total_count": len(jobs), "jobs": jobs}


class EventAndRunRecords(unittest.TestCase):
    def test_the_exact_successful_main_event_resolves_its_head(self):
        self.assertEqual(
            contract.plan_workflow_run(workflow_run_event(), REPOSITORY), "a" * 40
        )

    def test_every_foreign_event_field_denies(self):
        for override in (
            {"conclusion": "failure"},
            {"event": "pull_request"},
            {"head_branch": "topic"},
            {"status": "in_progress"},
            {"name": "Other"},
            {"path": ".github/workflows/other.yml"},
            {"head_repository": {"full_name": "someone/else"}},
            {"head_sha": "not-a-sha"},
        ):
            with self.subTest(override=sorted(override)):
                with self.assertRaises(contract.ContractError):
                    contract.plan_workflow_run(workflow_run_event(**override), REPOSITORY)

    def test_a_foreign_repository_denies(self):
        with self.assertRaises(contract.ContractError):
            contract.plan_workflow_run(workflow_run_event(), "someone/else")

    def test_the_main_run_record_binds_run_id_and_source(self):
        self.assertEqual(
            contract.validate_main_run_record(
                main_run_record(),
                expected_repository=REPOSITORY,
                expected_run_id=42,
                expected_source_sha="a" * 40,
            ),
            "a" * 40,
        )
        for override, run_id in (
            ({}, 43),
            ({"id": 43}, 42),
            ({"conclusion": "cancelled"}, 42),
            ({"head_sha": "b" * 40}, 42),
            ({"repository": {"full_name": "someone/else"}}, 42),
        ):
            with self.subTest(override=sorted(override), run_id=run_id):
                with self.assertRaises(contract.ContractError):
                    contract.validate_main_run_record(
                        main_run_record(**override),
                        expected_repository=REPOSITORY,
                        expected_run_id=run_id,
                        expected_source_sha="a" * 40,
                    )

    def test_the_job_inventory_is_exact_in_both_directions(self):
        expected = contract.EXPECTED_MAIN_JOBS
        self.assertEqual(
            contract.validate_main_jobs_record(
                jobs_record(expected), expected_run_id=42, expected_source_sha="a" * 40
            ),
            "a" * 40,
        )
        missing = dict(expected)
        missing.pop("gate")
        extra = {**expected, "surprise": "success"}
        wrong = {**expected, "gate": "skipped"}
        # A RENAMED job keeps the count identical, so only the per-job foreign
        # name refusal can catch it -- and a rename is the realistic way a job
        # leaves the inventory the publisher authorizes against.
        renamed = dict(expected)
        renamed["aggregate"] = renamed.pop("gate")
        for label, inventory in (
            ("missing", missing),
            ("extra", extra),
            ("wrong", wrong),
            ("renamed", renamed),
        ):
            with self.subTest(inventory=label):
                with self.assertRaises(contract.ContractError):
                    contract.validate_main_jobs_record(
                        jobs_record(inventory),
                        expected_run_id=42,
                        expected_source_sha="a" * 40,
                    )

    def test_a_job_from_another_run_or_sha_denies(self):
        for record in (
            jobs_record(contract.EXPECTED_MAIN_JOBS, run_id=99),
            jobs_record(contract.EXPECTED_MAIN_JOBS, source_sha="b" * 40),
        ):
            with self.subTest():
                with self.assertRaises(contract.ContractError):
                    contract.validate_main_jobs_record(
                        record, expected_run_id=42, expected_source_sha="a" * 40
                    )

    def test_a_lying_total_count_denies(self):
        record = jobs_record(contract.EXPECTED_MAIN_JOBS)
        record["total_count"] = 99
        with self.assertRaises(contract.ContractError):
            contract.validate_main_jobs_record(
                record, expected_run_id=42, expected_source_sha="a" * 40
            )

    def test_codeql_runs_resolve_pending_success_and_denial(self):
        def runs(**overrides: object) -> dict:
            run = {
                "id": 7,
                "name": contract.EXPECTED_CODEQL_WORKFLOW,
                "path": contract.EXPECTED_CODEQL_WORKFLOW_PATH,
                "event": "push",
                "head_branch": "main",
                "head_sha": "a" * 40,
                "status": "completed",
                "conclusion": "success",
                "repository": {"full_name": REPOSITORY},
                "head_repository": {"full_name": REPOSITORY},
            }
            run.update(overrides)
            return {"total_count": 1, "workflow_runs": [run]}

        resolve = lambda record: contract.classify_codeql_run_record(  # noqa: E731
            record, expected_repository=REPOSITORY, expected_source_sha="a" * 40
        )
        self.assertEqual(resolve(runs()), 7)
        self.assertIsNone(resolve({"total_count": 0, "workflow_runs": []}))
        self.assertIsNone(resolve(runs(status="in_progress", conclusion=None)))
        for override in (
            {"conclusion": "cancelled"},
            {"conclusion": "failure"},
            {"head_sha": "b" * 40},
            {"event": "schedule"},
            {"status": "queued"},
        ):
            with self.subTest(override=sorted(override)):
                with self.assertRaises(contract.ContractError):
                    resolve(runs(**override))

    def test_both_codeql_matrix_jobs_are_required(self):
        self.assertEqual(
            contract.validate_codeql_jobs_record(
                jobs_record(contract.EXPECTED_CODEQL_JOBS, run_id=7),
                expected_run_id=7,
                expected_source_sha="a" * 40,
            ),
            "a" * 40,
        )
        with self.assertRaises(contract.ContractError):
            contract.validate_codeql_jobs_record(
                jobs_record({"analyze (rust, none)": "success"}, run_id=7),
                expected_run_id=7,
                expected_source_sha="a" * 40,
            )


class PublisherAuthority(GitFixture):
    def arguments(self, **overrides: str) -> dict:
        base = {
            "source_sha": self.base,
            "checkout_sha": self.base,
            "ref": "refs/heads/main",
            "event_name": "workflow_dispatch",
            "repository": REPOSITORY,
            "workflow_ref": f"{REPOSITORY}/{contract.EXPECTED_PUBLISHER_PATH}@refs/heads/main",
            "image": IMAGE,
            "chart": CHART,
        }
        base.update(overrides)
        return base

    def test_the_authorized_publisher_resolves_its_intent(self):
        intent = contract.validate_publisher(self.root, **self.arguments())
        self.assertEqual((intent.source_sha, intent.tag), (self.base, "v0.1.0"))

    def test_every_unauthorized_shape_denies(self):
        for override in (
            {"event_name": "push"},
            {"ref": "refs/heads/topic"},
            {"workflow_ref": f"{REPOSITORY}/.github/workflows/other.yml@refs/heads/main"},
            {"workflow_ref": f"{REPOSITORY}/{contract.EXPECTED_PUBLISHER_PATH}@refs/heads/topic"},
            {"repository": "someone/else"},
            {"image": "ghcr.io/someone/else"},
            {"chart": "ghcr.io/someone/charts/else"},
            {"checkout_sha": "b" * 40},
            {"source_sha": "not-a-sha"},
        ):
            with self.subTest(override=sorted(override)):
                with self.assertRaises(contract.ContractError):
                    contract.validate_publisher(self.root, **self.arguments(**override))


def manifest_arguments(**overrides: object) -> dict:
    arguments = {
        "repository": REPOSITORY,
        "source_sha": "a" * 40,
        "main_run_id": 42,
        "version": "0.1.4",
        "image": IMAGE,
        "image_digest": IMAGE_DIGEST,
        "chart": CHART,
        "chart_digest": CHART_DIGEST,
        "plugin_digest": PLUGIN_DIGEST,
    }
    arguments.update(overrides)
    return arguments


def node(value: object) -> dict:
    """Narrow one manifest branch, refusing anything that is not a mapping."""
    assert isinstance(value, dict), value
    return value


class TheEvidenceManifest(unittest.TestCase):
    def test_the_manifest_is_deterministic_and_complete(self):
        first = contract.build_release_manifest(**manifest_arguments())
        second = contract.build_release_manifest(**manifest_arguments())
        self.assertEqual(first, second)
        self.assertEqual(first["release"], {"version": "0.1.4", "tag": "v0.1.4"})
        artifacts = node(first["artifacts"])
        image = node(artifacts["image"])
        bundle = node(artifacts["plugin_bundle"])
        self.assertEqual(image["platforms"], ["linux/amd64", "linux/arm64"])
        self.assertEqual(bundle["name"], "obsync-plugin-v0.1.4.zip")
        self.assertEqual(bundle["digest"], PLUGIN_DIGEST)
        self.assertEqual(bundle["contents"], ["main.js", "manifest.json", "styles.css"])
        self.assertEqual(
            image["signature_identity"],
            f"https://github.com/{REPOSITORY}/{contract.EXPECTED_PUBLISHER_PATH}@refs/heads/main",
        )

    def test_a_sentinel_or_malformed_digest_never_reaches_the_manifest(self):
        for override in (
            {"image_digest": SENTINEL},
            {"chart_digest": SENTINEL},
            {"image_digest": "sha256:short"},
            {"plugin_digest": "nope"},
            {"main_run_id": 0},
            {"version": "v0.1.4"},
            {"repository": "someone/else"},
        ):
            with self.subTest(override=sorted(override)):
                with self.assertRaises(contract.ContractError):
                    contract.build_release_manifest(**manifest_arguments(**override))

    def test_the_record_validator_refuses_any_drift(self):
        manifest = contract.build_release_manifest(**manifest_arguments())
        contract.validate_release_manifest_record(manifest, **manifest_arguments())
        drifted = json.loads(json.dumps(manifest))
        node(node(drifted["artifacts"])["image"])["digest"] = CHART_DIGEST
        with self.assertRaises(contract.ContractError):
            contract.validate_release_manifest_record(drifted, **manifest_arguments())

    def test_the_notes_name_every_artifact_by_digest(self):
        notes = contract.build_release_notes(
            contract.build_release_manifest(**manifest_arguments())
        )
        for expected in (
            "## obsync v0.1.4",
            f"{IMAGE}:v0.1.4@{IMAGE_DIGEST}",
            f"{CHART}:0.1.4@{CHART_DIGEST}",
            "obsync-plugin-v0.1.4.zip",
            "obsync-v0.1.4-release-manifest.json",
        ):
            with self.subTest(expected=expected):
                self.assertIn(expected, notes)


def release_record(state: str = "exact", assets: list | None = None, **overrides: object) -> dict:
    record = {
        "author": {"login": "github-actions[bot]", "id": 41898282},
        "tag_name": "v0.1.4",
        "name": "obsync v0.1.4",
        "body": "notes",
        "prerelease": False,
        "draft": state != "exact",
        "immutable": state == "exact",
        "assets": [] if assets is None else assets,
    }
    record.update(overrides)
    return record


def assets(manifest: bytes) -> list[dict]:
    import hashlib

    return [
        {
            "uploader": {"login": "github-actions[bot]", "id": 41898282},
            "name": "obsync-v0.1.4-release-manifest.json",
            "content_type": "application/json",
            "state": "uploaded",
            "size": len(manifest),
            "digest": "sha256:" + hashlib.sha256(manifest).hexdigest(),
        },
        {
            "uploader": {"login": "github-actions[bot]", "id": 41898282},
            "name": "obsync-plugin-v0.1.4.zip",
            "content_type": "application/zip",
            "state": "uploaded",
            "digest": PLUGIN_DIGEST,
        },
    ]


class ThePublicationStateMachines(unittest.TestCase):
    MANIFEST = b'{"schema":"x"}\n'

    def release_arguments(self) -> dict:
        return {
            "tag": "v0.1.4",
            "title": "obsync v0.1.4",
            "body": "notes",
            "manifest": self.MANIFEST,
            "plugin_digest": PLUGIN_DIGEST,
        }

    def test_the_release_states_classify_absent_prepared_staged_and_exact(self):
        arguments = self.release_arguments()
        self.assertEqual(contract.classify_release_state(404, None, **arguments), "absent")
        self.assertEqual(
            contract.classify_release_state(200, release_record("staged"), **arguments), "prepared"
        )
        self.assertEqual(
            contract.classify_release_state(
                200, release_record("staged", assets(self.MANIFEST)), **arguments
            ),
            "staged",
        )
        self.assertEqual(
            contract.classify_release_state(
                200, release_record("exact", assets(self.MANIFEST)), **arguments
            ),
            "exact",
        )

    def test_a_published_release_must_report_immutable_and_both_assets(self):
        arguments = self.release_arguments()
        for record in (
            release_record("exact", assets(self.MANIFEST), immutable=False),
            release_record("exact", assets(self.MANIFEST)[:1]),
            release_record("exact", assets(self.MANIFEST), prerelease=True),
            release_record("exact", assets(self.MANIFEST), body="different"),
            release_record("exact", assets(self.MANIFEST), tag_name="v0.1.5"),
            release_record(
                "exact", assets(self.MANIFEST), author={"login": "someone", "id": 1}
            ),
        ):
            with self.subTest():
                with self.assertRaises(contract.ContractError):
                    contract.classify_release_state(200, record, **arguments)

    def test_the_terminal_record_check_refuses_a_still_mutable_release(self):
        # The publisher and the audit both call `release-record` DIRECTLY, on
        # a Release they expect to be published. Reached that way there is no
        # classifier upstream to have derived the state, so this is the only
        # thing standing between "we published" and "a draft still sitting
        # there, editable, that we called immutable".
        for record in (
            release_record("staged", assets(self.MANIFEST)),
            release_record("exact", assets(self.MANIFEST), immutable=False),
            release_record("exact", assets(self.MANIFEST), draft=True),
        ):
            with self.subTest():
                with self.assertRaises(contract.ContractError):
                    contract.validate_release_record(record, **self.release_arguments())

    def test_a_replaced_asset_is_refused_by_its_digest(self):
        forged = assets(self.MANIFEST)
        forged[1]["digest"] = "sha256:" + "9" * 64
        with self.assertRaises(contract.ContractError):
            contract.classify_release_state(200, release_record("exact", forged), **self.release_arguments())

    def test_an_unexpected_http_status_denies_rather_than_defaulting(self):
        for status in (403, 500, 302):
            with self.subTest(status=status):
                with self.assertRaises(contract.ContractError):
                    contract.classify_release_state(status, None, **self.release_arguments())
                with self.assertRaises(contract.ContractError):
                    contract.classify_registry_response(status)

    def test_registry_states_are_present_or_absent_only(self):
        self.assertEqual(contract.classify_registry_response(200), "present")
        self.assertEqual(contract.classify_registry_response(404), "absent")

    def test_the_tag_state_requires_an_annotated_tag_at_the_exact_source(self):
        expected = {
            "tag": "v0.1.4",
            "source_sha": "a" * 40,
            "message": "Release v0.1.4 from " + "a" * 40,
            "tagger_name": "github-actions[bot]",
            "tagger_email": "41898282+github-actions[bot]@users.noreply.github.com",
            "tagger_date": "2026-09-07T00:00:00Z",
        }
        ref = {"ref": "refs/tags/v0.1.4", "object": {"type": "tag", "sha": "c" * 40}}
        tag = {
            "sha": "c" * 40,
            "tag": "v0.1.4",
            "message": expected["message"],
            "object": {"type": "commit", "sha": "a" * 40},
            "tagger": {
                "name": expected["tagger_name"],
                "email": expected["tagger_email"],
                "date": "2026-09-07T00:00:00+00:00",
            },
        }
        self.assertEqual(contract.classify_tag_state(404, None, None, **expected), "absent")
        self.assertEqual(contract.classify_tag_state(200, ref, tag, **expected), "exact")
        for label, bad_ref, bad_tag in (
            ("lightweight", {**ref, "object": {"type": "commit", "sha": "c" * 40}}, tag),
            ("wrong target", ref, {**tag, "object": {"type": "commit", "sha": "b" * 40}}),
            ("wrong message", ref, {**tag, "message": "Release v0.1.4"}),
            ("foreign tagger", ref, {**tag, "tagger": {**tag["tagger"], "name": "someone"}}),
            ("drifted date", ref, {**tag, "tagger": {**tag["tagger"], "date": "2026-09-08T00:00:00Z"}}),
        ):
            with self.subTest(label=label):
                with self.assertRaises(contract.ContractError):
                    contract.classify_tag_state(200, bad_ref, bad_tag, **expected)

    def test_the_required_state_assertion_is_exact(self):
        self.assertEqual(contract.require_publication_state("exact", "exact"), "exact")
        for actual, required in (("absent", "exact"), ("exact", "absent"), ("exact", "nonsense")):
            with self.subTest(actual=actual, required=required):
                with self.assertRaises(contract.ContractError):
                    contract.require_publication_state(actual, required)

    def test_an_alias_is_reused_only_when_source_and_signature_both_match(self):
        self.assertEqual(
            contract.classify_artifact(present=False, source_match=False, signature_match=False),
            "absent",
        )
        self.assertEqual(
            contract.classify_artifact(present=True, source_match=True, signature_match=True),
            "complete",
        )
        for source_match, signature_match in ((True, False), (False, True), (False, False)):
            with self.subTest(source=source_match, signature=signature_match):
                self.assertEqual(
                    contract.classify_artifact(
                        present=True, source_match=source_match, signature_match=signature_match
                    ),
                    "burned",
                )
        with self.assertRaises(contract.ContractError):
            contract.classify_artifact(present=False, source_match=True, signature_match=False)


class TheGovernanceReceipt(unittest.TestCase):
    """docs/release.md, "Governance receipt" -- the owner-activated settings."""

    def receipt(self, **overrides: object) -> dict:
        record = {
            "repository": REPOSITORY,
            "branch": "main",
            "immutable_releases": True,
            "default_workflow_permissions": "read",
            "merge_methods": ["rebase", "squash"],
            "required_status_checks": [
                {"context": context, "integration_id": contract.GITHUB_ACTIONS_INTEGRATION_ID}
                for context in contract.REQUIRED_STATUS_CHECKS
            ],
            "strict_status_checks": True,
            "require_pull_request": True,
            "require_linear_history": True,
            "require_signed_commits": True,
            "restrict_creations": True,
            "allow_deletions": False,
            "allow_force_pushes": False,
            "secret_scanning": True,
            "secret_scanning_push_protection": True,
        }
        record.update(overrides)
        return record

    def test_the_exact_receipt_is_accepted(self):
        contract.validate_settings_receipt(self.receipt(), REPOSITORY)

    def test_every_weakened_setting_denies(self):
        for override in (
            {"immutable_releases": False},
            {"strict_status_checks": False},
            {"require_signed_commits": False},
            {"require_linear_history": False},
            {"allow_force_pushes": True},
            {"allow_deletions": True},
            {"secret_scanning_push_protection": False},
            {"default_workflow_permissions": "write"},
            {"merge_methods": ["merge", "squash", "rebase"]},
            {"required_status_checks": []},
        ):
            with self.subTest(override=sorted(override)):
                with self.assertRaises(contract.ContractError):
                    contract.validate_settings_receipt(self.receipt(**override), REPOSITORY)

    def test_a_required_check_bound_to_a_foreign_app_denies(self):
        checks = [
            {"context": context, "integration_id": 999}
            for context in contract.REQUIRED_STATUS_CHECKS
        ]
        with self.assertRaises(contract.ContractError):
            contract.validate_settings_receipt(
                self.receipt(required_status_checks=checks), REPOSITORY
            )

    def test_a_missing_or_foreign_field_denies(self):
        short = self.receipt()
        short.pop("immutable_releases")
        with self.assertRaises(contract.ContractError):
            contract.validate_settings_receipt(short, REPOSITORY)
        with self.assertRaises(contract.ContractError):
            contract.validate_settings_receipt(self.receipt(surprise=True), REPOSITORY)

    def test_a_foreign_repository_or_branch_denies(self):
        with self.assertRaises(contract.ContractError):
            contract.validate_settings_receipt(self.receipt(), "someone/else")
        with self.assertRaises(contract.ContractError):
            contract.validate_settings_receipt(self.receipt(branch="topic"), REPOSITORY)


class TheRequiredCheckSetMatchesTheWorkflows(unittest.TestCase):
    """The ruleset contexts and the publisher's job inventory are one fact."""

    def test_every_expected_main_job_is_a_required_check(self):
        for job in contract.EXPECTED_MAIN_JOBS:
            with self.subTest(job=job):
                self.assertIn(job, contract.REQUIRED_STATUS_CHECKS)

    def test_every_codeql_matrix_job_is_a_required_check(self):
        for job in contract.EXPECTED_CODEQL_JOBS:
            with self.subTest(job=job):
                self.assertIn(job, contract.REQUIRED_STATUS_CHECKS)

    def test_the_required_set_names_nothing_else(self):
        self.assertEqual(
            set(contract.REQUIRED_STATUS_CHECKS),
            set(contract.EXPECTED_MAIN_JOBS) | set(contract.EXPECTED_CODEQL_JOBS),
        )

    def test_the_expected_main_jobs_are_the_workflow_jobs(self):
        # The publisher authorizes against this inventory, so a job renamed or
        # added in pr-gate.yml without updating the contract must fail HERE
        # rather than at the next release.
        self.assertEqual(set(workflow("pr-gate.yml")["jobs"]), set(contract.EXPECTED_MAIN_JOBS))

    def test_the_codeql_matrix_names_the_expected_jobs(self):
        matrix = workflow("codeql.yml")["jobs"]["analyze"]["strategy"]["matrix"]["include"]
        rendered = {
            f"analyze ({entry['language']}, {entry['build-mode']})" for entry in matrix
        }
        self.assertEqual(rendered, set(contract.EXPECTED_CODEQL_JOBS))


class TheImageBuildIsARequiredGateJob(unittest.TestCase):
    """`container` builds the released image on every PR, and cannot be lost quietly.

    The gate used to prove everything about this repository EXCEPT the artifact
    it ships: nothing ran `docker build`, so a stage that could not build at
    all -- or an in-image test that reached the network -- was discovered by
    hand, or at release time, long after the merge that broke it.

    There are three separate ways to lose that coverage again and each has its
    own refusal below: the job deleted from the workflow, the job still running
    but no longer required by the aggregate `gate` context, or the job dropped
    from the inventory the publisher authorizes a release against. The set
    equality in `TheRequiredCheckSetMatchesTheWorkflows` catches neither of the
    last two, and catches the first only while the inventory still names it --
    delete the job from BOTH and that assertion goes green on an empty
    promise.
    """

    JOB = "container"

    @staticmethod
    def gate_jobs() -> dict:
        return workflow("pr-gate.yml")["jobs"]

    def test_the_workflow_declares_the_container_job(self):
        self.assertIn(self.JOB, self.gate_jobs())

    def test_the_container_job_is_in_the_publisher_inventory(self):
        # `REQUIRED_STATUS_CHECKS` follows from the inventory by the set
        # equality above, so naming the inventory here names both.
        self.assertEqual(contract.EXPECTED_MAIN_JOBS.get(self.JOB), "success")

    def test_the_aggregate_gate_requires_every_job_it_does_not_run(self):
        # Derived from the workflow, not from a second hardcoded list: a job
        # added later is required by the aggregate context or it is not a gate
        # at all, and this refuses the second case without needing an edit.
        jobs = self.gate_jobs()
        self.assertEqual(set(jobs["gate"]["needs"]), set(jobs) - {"gate"})

    def test_the_gate_step_asserts_the_result_of_every_job_it_needs(self):
        # `needs` alone only orders the jobs. The gate's own comment says each
        # result is asserted explicitly, because a skipped dependency leaves
        # this job skipped and a skipped required check can satisfy a ruleset.
        # So every needed job must reach the loop through its own variable.
        gate = self.gate_jobs()["gate"]
        step = gate["steps"][0]
        for job in gate["needs"]:
            with self.subTest(job=job):
                expression = "${{ needs." + job + ".result }}"
                variables = [
                    name for name, value in step["env"].items() if value == expression
                ]
                self.assertEqual(len(variables), 1, f"{job} has no result variable")
                self.assertIn(f'"{job}=${{{variables[0]}}}"', step["run"])

    def test_the_container_job_builds_the_image_and_pushes_nothing(self):
        # Vacuity: the three refusals above are equally satisfied by a job that
        # runs `true`. This one pins what the job is FOR -- both builds, the
        # release stage and the whole image -- and that it stays secretless:
        # no push, no registry login, no builder that could emulate a foreign
        # architecture, and a token that could not push if a step tried.
        job = self.gate_jobs()[self.JOB]
        body = "\n".join(
            step["run"] for step in job["steps"] if isinstance(step.get("run"), str)
        )
        self.assertIn("docker build --target server --tag", body)
        self.assertIn("docker build --tag", body)
        for forbidden in ("docker push", "docker login", "--platform", "buildx"):
            with self.subTest(forbidden=forbidden):
                self.assertNotIn(forbidden, body)
        self.assertEqual(job["permissions"], {"contents": "read"})


if __name__ == "__main__":
    unittest.main()
