"""Keep the reviewed dependency versions coherent across every build reader."""

import json
import re
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]


class NodeToolchainPins(unittest.TestCase):
    def test_every_node_reader_agrees_with_package_metadata(self):
        package = json.loads((ROOT / "plugin/package.json").read_text())
        lock = json.loads((ROOT / "plugin/package-lock.json").read_text())
        engines = package["engines"]
        self.assertEqual(lock["packages"][""]["engines"], engines)

        node = engines["node"]
        npm = engines["npm"]
        self.assertRegex(node, r"^[0-9]+\.[0-9]+\.[0-9]+$")
        self.assertRegex(npm, r"^[0-9]+\.[0-9]+\.[0-9]+$")

        agents = (ROOT / "AGENTS.md").read_text()
        self.assertIn(f"Node\n   {node}, npm {npm},", agents)

        dockerfile = (ROOT / "Dockerfile").read_text()
        node_images = re.findall(
            r"^FROM .*docker\.io/library/node:([^@ ]+)@sha256:([0-9a-f]{64}) AS plugin$",
            dockerfile,
            re.MULTILINE,
        )
        self.assertEqual(len(node_images), 1)
        self.assertEqual(node_images[0][0], f"{node}-trixie-slim")
        self.assertIn(f'test "$(node --version)" = "v{node}"', dockerfile)
        self.assertIn(f'test "$(npm --version)" = "{npm}"', dockerfile)

        workflow = (ROOT / ".github/workflows/pr-gate.yml").read_text()
        self.assertEqual(workflow.count(f"node-version: '{node}'"), 1)
        self.assertEqual(workflow.count(f'test "$(node --version)" = "v{node}"'), 1)
        self.assertEqual(workflow.count(f'test "$(npm --version)" = "{npm}"'), 1)

        ci_map = (ROOT / "docs/ci-map.md").read_text()
        self.assertIn(f"Node {node} / npm {npm}", ci_map)


class CodeqlActionPins(unittest.TestCase):
    def test_init_and_analyze_use_one_exact_release(self):
        workflow = (ROOT / ".github/workflows/codeql.yml").read_text()
        pins = re.findall(
            r"uses: github/codeql-action/(init|analyze)@([0-9a-f]{40}) # (v[0-9]+\.[0-9]+\.[0-9]+)$",
            workflow,
            re.MULTILINE,
        )
        self.assertEqual({role for role, _, _ in pins}, {"init", "analyze"})
        self.assertEqual(len(pins), 2)
        self.assertEqual(len({(sha, version) for _, sha, version in pins}), 1)


if __name__ == "__main__":
    unittest.main()
