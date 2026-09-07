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
        with self.assertRaises(contract.ContractError):
            self.classify(self.base, second)

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
        for label, inventory in (("missing", missing), ("extra", extra), ("wrong", wrong)):
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
        sys.path.insert(0, str(Path(__file__).resolve().parent))
        import miniyaml  # noqa: PLC0415

        root = Path(__file__).resolve().parents[2]
        workflow = miniyaml.load_one(
            (root / ".github" / "workflows" / "pr-gate.yml").read_text(encoding="utf-8")
        )
        self.assertEqual(set(workflow["jobs"]), set(contract.EXPECTED_MAIN_JOBS))

    def test_the_codeql_matrix_names_the_expected_jobs(self):
        sys.path.insert(0, str(Path(__file__).resolve().parent))
        import miniyaml  # noqa: PLC0415

        root = Path(__file__).resolve().parents[2]
        workflow = miniyaml.load_one(
            (root / ".github" / "workflows" / "codeql.yml").read_text(encoding="utf-8")
        )
        matrix = workflow["jobs"]["analyze"]["strategy"]["matrix"]["include"]
        rendered = {
            f"analyze ({entry['language']}, {entry['build-mode']})" for entry in matrix
        }
        self.assertEqual(rendered, set(contract.EXPECTED_CODEQL_JOBS))


if __name__ == "__main__":
    unittest.main()
