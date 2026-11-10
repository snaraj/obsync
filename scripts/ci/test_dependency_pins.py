"""Keep the reviewed dependency pins coherent across every build reader.

These assert AGREEMENT, never a value: a digest, a version or a sentence's
line wrap written into this file turns every Dependabot update red from birth.
What must hold is that every reader names the same pin, and that each pin is
immutable. Full-SHA action pins are `test_workflow_integrity.py`'s rule.
"""

import json
import re
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
WORKFLOWS = sorted((ROOT / ".github/workflows").glob("*.yml"))
DIGEST = r"@sha256:[0-9a-f]{64}"


def read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def flat(path: Path) -> str:
    """Prose with its line wrap removed, so a re-wrapped paragraph still agrees."""
    return re.sub(r"\s+", " ", read(path))


def executable(text: str) -> str:
    return "\n".join(line for line in text.splitlines() if not line.lstrip().startswith("#"))


class NodeToolchainPins(unittest.TestCase):
    def test_every_node_reader_agrees_with_package_metadata(self):
        package = json.loads(read(ROOT / "plugin/package.json"))
        lock = json.loads(read(ROOT / "plugin/package-lock.json"))
        engines = package["engines"]
        self.assertEqual(lock["packages"][""]["engines"], engines)
        node, npm = engines["node"], engines["npm"]
        self.assertRegex(node, r"^[0-9]+\.[0-9]+\.[0-9]+$")
        self.assertRegex(npm, r"^[0-9]+\.[0-9]+\.[0-9]+$")

        dockerfile = read(ROOT / "Dockerfile")
        images = re.findall(rf"^FROM .*docker\.io/library/node:([^@ ]+)({DIGEST})? AS plugin$",
                            dockerfile, re.MULTILINE)
        self.assertEqual(len(re.findall(r"library/node:", executable(dockerfile))), 1)
        self.assertEqual(len(images), 1, "exactly one digest-pinned node image builds the plugin")
        tag, digest = images[0]
        self.assertTrue(digest, "the node image is pinned by digest")
        self.assertEqual(tag.split("-", 1)[0], node)
        self.assertIn(f'test "$(node --version)" = "v{node}"', dockerfile)
        self.assertIn(f'test "$(npm --version)" = "{npm}"', dockerfile)

        setups = [re.findall(r"node-version: '([^']+)'", read(path)) for path in WORKFLOWS]
        self.assertTrue(any(setups))
        self.assertEqual({version for found in setups for version in found}, {node})
        for name, expected in (("node", node), ("npm", npm)):
            seen = {version for path in WORKFLOWS
                    for version in re.findall(rf'test "\$\({name} --version\)" = "v?([^"]+)"', read(path))}
            self.assertEqual(seen, {expected}, f"workflow {name} assertions")

        self.assertIn(f"Node {node}, npm {npm},", flat(ROOT / "AGENTS.md"))
        self.assertIn(f"Node {node} / npm {npm}", flat(ROOT / "docs/ci-map.md"))


class RustToolchainPins(unittest.TestCase):
    def test_the_toolchain_is_one_version_wherever_it_is_named(self):
        channel = re.search(r'^channel = "([0-9]+\.[0-9]+\.[0-9]+)"$',
                            read(ROOT / "rust-toolchain.toml"), re.MULTILINE).group(1)
        readers = [ROOT / "Dockerfile", *WORKFLOWS]
        named = [
            (path.name, version)
            for path in readers
            for version in re.findall(r"""test "\$\((?:rustc|cargo) --version \| awk '\{print \$2\}'\)" = "([^"]+)\"""",
                                      read(path))
        ]
        self.assertIn("Dockerfile", {name for name, _ in named})
        self.assertIn("pr-gate.yml", {name for name, _ in named})
        self.assertEqual({version for _, version in named}, {channel}, named)
        self.assertIn('rustup toolchain install;', read(ROOT / "Dockerfile"))
        self.assertIn(f"Rust {channel}", flat(ROOT / "AGENTS.md"))

    def test_one_digest_pinned_rust_image_builds_the_server(self):
        dockerfile = executable(read(ROOT / "Dockerfile"))
        self.assertEqual(len(re.findall(r"library/rust:", dockerfile)), 1)
        self.assertRegex(dockerfile, rf"(?m)^FROM .*docker\.io/library/rust:[^@ ]+{DIGEST} AS server$")


class ActionPins(unittest.TestCase):
    def test_every_action_repository_is_one_commit_and_one_version(self):
        # codeql-action's init and analyze, every checkout: a half-applied
        # update runs two releases of one action side by side.
        pins: dict[str, set[tuple[str, str]]] = {}
        for path in WORKFLOWS:
            for owner, repository, sha, version in re.findall(
                r"uses: ([\w.-]+)/([\w.-]+)(?:/[\w./-]+)?@([0-9a-f]{40}) # (\S+)$",
                read(path), re.MULTILINE,
            ):
                pins.setdefault(f"{owner}/{repository}", set()).add((sha, version))
        self.assertIn("github/codeql-action", pins)
        for repository, seen in pins.items():
            with self.subTest(action=repository):
                self.assertEqual(len(seen), 1, sorted(seen))
        codeql = read(ROOT / ".github/workflows/codeql.yml")
        self.assertEqual({role for role in re.findall(r"uses: github/codeql-action/(\w+)@", codeql)},
                         {"init", "analyze"})


class ImagePins(unittest.TestCase):
    THIRD_PARTY = re.compile(
        r"(?<![\w./-])((?:docker\.io|gcr\.io|quay\.io|registry\.k8s\.io|mcr\.microsoft\.com)/[\w./-]+"
        r"|kindest/node)(:[\w.-]+)?(@sha256(?::[0-9a-f]{64})?)?"
    )

    def test_every_base_image_is_pinned_by_digest(self):
        dockerfile = read(ROOT / "Dockerfile")
        stages = set(re.findall(r"(?m)^FROM .* AS (\S+)$", dockerfile))
        for line in re.findall(r"(?m)^FROM (?:--platform=\S+ )?(\S+)", dockerfile):
            with self.subTest(base=line):
                if line not in stages | {"scratch"}:
                    self.assertRegex(line, rf"{DIGEST}$")

    def test_every_third_party_image_ci_or_compose_pulls_is_pinned_by_digest(self):
        readers = [*WORKFLOWS, *sorted((ROOT / "scripts").rglob("*.sh")),
                   *sorted((ROOT / "deploy").rglob("*.yml"))]
        found = 0
        for path in readers:
            for name, _tag, digest in self.THIRD_PARTY.findall(executable(read(path))):
                if digest == "@sha256":
                    continue  # a message naming the digest form, not a reference
                found += 1
                with self.subTest(path=path.relative_to(ROOT).as_posix(), image=name):
                    self.assertTrue(digest, "pull by digest; a tag moves")
        self.assertGreater(found, 0)


if __name__ == "__main__":
    unittest.main()
