"""Hostile tests for the fail-closed reader every structural gate depends on.

Two properties matter here and they pull in opposite directions, so both are
tested explicitly. The reader must RESOLVE the shapes Helm and GitHub Actions
actually emit -- a gate that cannot read the render is a gate nobody keeps --
and it must REFUSE everything else, because a construct it half-understood
would be a construct an attacker could hide a second NetworkPolicy or a second
`permissions:` block inside.
"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import miniyaml  # noqa: E402


class ResolvesRealDocuments(unittest.TestCase):
    def test_block_mapping_sequence_and_scalars(self):
        document = miniyaml.load_one(
            "kind: Deployment\n"
            "metadata:\n"
            "  name: obsync\n"
            "  labels:\n"
            "    app: obsync\n"
            "spec:\n"
            "  replicas: 1\n"
            "  paused: false\n"
            "  note: ~\n"
            "  ports:\n"
            "    - name: http\n"
            "      port: 8080\n"
            "    - name: admin\n"
            "      port: 9090\n"
        )
        self.assertEqual(document["metadata"]["labels"], {"app": "obsync"})
        self.assertEqual(document["spec"]["replicas"], 1)
        self.assertIs(document["spec"]["paused"], False)
        self.assertIsNone(document["spec"]["note"])
        self.assertEqual(
            document["spec"]["ports"],
            [{"name": "http", "port": 8080}, {"name": "admin", "port": 9090}],
        )

    def test_multiple_documents_comments_and_terminators(self):
        documents = miniyaml.loads(
            "---\n# Source: a\nkind: A\n...\n---\nkind: B  # trailing\n\n---\n"
        )
        self.assertEqual([document["kind"] for document in documents], ["A", "B"])

    def test_flow_collections_the_workflows_use(self):
        document = miniyaml.load_one(
            "permissions: {}\n"
            "on:\n"
            "  push:\n"
            "    branches: [main]\n"
            "needs: [security, application, chart]\n"
            "grant: {contents: read}\n"
        )
        self.assertEqual(document["permissions"], {})
        self.assertEqual(document["on"]["push"]["branches"], ["main"])
        self.assertEqual(document["needs"], ["security", "application", "chart"])
        self.assertEqual(document["grant"], {"contents": "read"})

    def test_a_block_scalar_body_is_never_read_as_structure(self):
        # THE point of capturing `run:` raw. A shell body full of YAML-shaped
        # text must not be able to declare a job, a permission, or a peer.
        document = miniyaml.load_one(
            "steps:\n"
            "  - name: Run\n"
            "    run: |\n"
            "      permissions: write-all\n"
            "      kind: NetworkPolicy\n"
            "  - name: Next\n"
            "    run: echo done\n"
        )
        self.assertEqual(len(document["steps"]), 2)
        self.assertNotIn("permissions", document)
        self.assertNotIn("kind", document)
        self.assertIn("permissions: write-all", document["steps"][0]["run"])

    def test_quoted_scalars_keep_their_punctuation(self):
        document = miniyaml.load_one(
            'image: "ghcr.io/snaraj/obsync:v0.1.0@sha256:abc"\n'
            "digest: sha256:0000\n"
            "cron: '41 9 * * 6'\n"
            'escaped: "a\\nb"\n'
        )
        self.assertEqual(document["image"], "ghcr.io/snaraj/obsync:v0.1.0@sha256:abc")
        self.assertEqual(document["digest"], "sha256:0000")
        self.assertEqual(document["cron"], "41 9 * * 6")
        self.assertEqual(document["escaped"], "a\nb")

    def test_a_hash_inside_a_quoted_scalar_is_not_a_comment(self):
        document = miniyaml.load_one('value: "keep # this"\n')
        self.assertEqual(document["value"], "keep # this")


class RefusesWhatItCannotModel(unittest.TestCase):
    def refuses(self, text: str) -> None:
        with self.assertRaises(miniyaml.YamlError):
            miniyaml.loads(text)

    def test_anchors_aliases_tags_and_merge_keys(self):
        for text in (
            "a: &anchor value\n",
            "a: *alias\n",
            "a: !!str value\n",
            "a:\n  <<: b\n",
        ):
            with self.subTest(text=text):
                self.refuses(text)

    def test_nested_flow_collections(self):
        self.refuses("a: [{b: c}]\n")
        self.refuses("a: {b: [c]}\n")

    def test_duplicate_keys(self):
        self.refuses("a: 1\na: 2\n")
        self.refuses("a: {b: 1, b: 2}\n")

    def test_tab_indentation(self):
        self.refuses("a:\n\tb: c\n")

    def test_an_unterminated_flow_collection(self):
        self.refuses("a: [b, c\n")

    def test_an_unmodelled_string_escape(self):
        self.refuses('a: "b\\qc"\n')

    def test_a_line_that_is_not_a_mapping_entry(self):
        self.refuses("a: 1\nnot a mapping entry\n")

    def test_load_one_refuses_a_multi_document_stream(self):
        with self.assertRaises(miniyaml.YamlError):
            miniyaml.load_one("kind: A\n---\nkind: B\n")


class ReadsTheRepositorysOwnFiles(unittest.TestCase):
    """The reader is only useful if it resolves what this repository ships."""

    def test_every_workflow_and_the_chart_metadata_resolve(self):
        root = Path(__file__).resolve().parents[2]
        targets = sorted((root / ".github" / "workflows").glob("*.yml"))
        targets.append(root / ".github" / "dependabot.yml")
        targets.append(root / "chart" / "Chart.yaml")
        targets.append(root / "chart" / "values.yaml")
        self.assertGreaterEqual(len(targets), 5)
        for path in targets:
            with self.subTest(path=path.name):
                self.assertIsInstance(
                    miniyaml.load_one(path.read_text(encoding="utf-8")), dict
                )


if __name__ == "__main__":
    unittest.main()
