"""Hostile tests for `scripts/ci/image-handoff.sh`, the build-once hand-off.

Every job that exercises the shipped image loads the one `container` (or
`image-arm64`) built and proved, and the property all of them rest on is that
`take` refuses ANY other image before using it. These drive the real script
against a stand-in `docker` first on PATH, which answers from fixture state
and records every call, so each refusal is proven by what never happened
after it: no `docker tag`, no `docker load`.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().with_name("image-handoff.sh")
BASH = shutil.which("bash") or "/bin/bash"
PROVED = "sha256:" + "c" * 64
OTHER = "sha256:" + "d" * 64
TAG = "obsync-proxy-e2e:abc"

FAKE_DOCKER = """#!{python} -I
import json, os, sys
state_path = os.environ["FAKE_DOCKER_STATE"]
with open(state_path) as handle:
    state = json.load(handle)
args = sys.argv[1:]
with open(os.environ["FAKE_DOCKER_CALLS"], "a") as log:
    log.write(json.dumps(args) + "\\n")
if args[:3] == ["image", "inspect", "--format"] and len(args) == 5:
    if args[4] in state["images"]:
        print(state["images"][args[4]])
        sys.exit(0)
    print("Error: No such image: " + args[4], file=sys.stderr)
    sys.exit(1)
if args[:2] == ["save", "--output"] and len(args) == 4:
    with open(args[2], "wb") as archive:
        archive.write(b"archive")
    sys.exit(0)
if args[:2] == ["load", "--input"] and len(args) == 3:
    state["images"].update(state.get("loads", {{}}))
    with open(state_path, "w") as handle:
        json.dump(state, handle)
    sys.stdout.write(state.get("load_output", ""))
    sys.exit(0)
if args[0] == "tag" and len(args) == 3:
    sys.exit(0 if args[1] in state["images"] else 1)
if args[:2] == ["build", "--tag"] and len(args) == 4:
    sys.exit(0)
print("fake docker: unexpected call " + " ".join(args), file=sys.stderr)
sys.exit(2)
"""


class TheHandOffTakesOnlyTheProvedImage(unittest.TestCase):
    def setUp(self) -> None:
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        (self.root / "bin").mkdir()
        docker = self.root / "bin" / "docker"
        docker.write_text(FAKE_DOCKER.format(python=sys.executable), encoding="utf-8")
        docker.chmod(0o755)
        self.state = self.root / "state.json"
        self.calls = self.root / "calls.jsonl"

    def run_handoff(self, *args: str, images: dict | None = None, loads: dict | None = None,
                    load_output: str = "") -> subprocess.CompletedProcess:
        self.state.write_text(json.dumps({"images": images or {}, "loads": loads or {},
                                          "load_output": load_output}), encoding="utf-8")
        self.calls.write_text("", encoding="utf-8")
        environment = {"PATH": f"{self.root / 'bin'}:/usr/bin:/bin", "HOME": str(self.root),
                       "FAKE_DOCKER_STATE": str(self.state), "FAKE_DOCKER_CALLS": str(self.calls)}
        return subprocess.run([BASH, str(SCRIPT), *args], env=environment, cwd=self.root,
                              capture_output=True, text=True, timeout=30)

    def docker_calls(self) -> list[list[str]]:
        return [json.loads(line) for line in self.calls.read_text(encoding="utf-8").splitlines()]

    def verbs(self) -> list[str]:
        return [call[0] for call in self.docker_calls()]

    def take(self, want: str, load_output: str, loads: dict) -> subprocess.CompletedProcess:
        return self.run_handoff("take", want, str(self.root / "handoff"), TAG,
                                loads=loads, load_output=load_output)

    def test_the_proved_image_is_tagged_with_exactly_the_requested_tag(self):
        result = self.take(PROVED, "Loaded image: obsync-gate-full:abc\n",
                           {"obsync-gate-full:abc": PROVED, PROVED: PROVED})
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.docker_calls()[-1], ["tag", PROVED, TAG])
        self.assertEqual(self.verbs().count("tag"), 1)
        self.assertNotIn("build", self.verbs())

    def test_the_untagged_load_form_resolves_too(self):
        result = self.take(PROVED, f"Loaded image ID: {PROVED}\n", {PROVED: PROVED})
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.docker_calls()[-1], ["tag", PROVED, TAG])

    def test_another_image_is_refused_and_never_tagged(self):
        result = self.take(PROVED, "Loaded image: obsync-gate-full:abc\n",
                           {"obsync-gate-full:abc": OTHER, OTHER: OTHER})
        self.assertNotEqual(result.returncode, 0)
        self.assertIn(f"loaded {OTHER}, which is not the image the building job proved ({PROVED})",
                      result.stderr)
        self.assertEqual(self.verbs(), ["load", "image"])

    def test_an_archive_holding_two_images_is_refused_by_count(self):
        result = self.take(PROVED, "Loaded image: obsync-gate-full:abc\nLoaded image: stray:1\n",
                           {"obsync-gate-full:abc": PROVED, "stray:1": OTHER})
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("expected exactly one image", result.stderr)
        self.assertIn("loaded 2", result.stderr)
        # Refused on the count itself: nothing is inspected, let alone tagged.
        self.assertEqual(self.verbs(), ["load"])

    def test_an_archive_naming_no_image_counts_zero_and_is_refused(self):
        # `printf '%s' ''` piped to `grep -c ''` prints 0 and exits 1; the
        # `|| true` keeps the 0, and the count guard refuses it by name.
        for output in ("", "open image.tar: no such file\n"):
            with self.subTest(output=output):
                result = self.take(PROVED, output, {})
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("expected exactly one image", result.stderr)
                self.assertIn("loaded 0", result.stderr)
                self.assertEqual(self.verbs(), ["load"])

    def test_a_malformed_handed_over_id_is_refused_before_anything_loads(self):
        for want in ("notanid", "sha256:abc", "sha256:" + "C" * 64, PROVED + "\n" + OTHER, f" {PROVED}"):
            with self.subTest(want=want):
                result = self.take(want, "Loaded image: obsync-gate-full:abc\n",
                                   {"obsync-gate-full:abc": PROVED, PROVED: PROVED})
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("is not sha256:<64 hex>", result.stderr)
                self.assertEqual(self.docker_calls(), [])

    def test_a_standalone_run_builds_and_never_loads(self):
        result = self.take("", "Loaded image: obsync-gate-full:abc\n", {"obsync-gate-full:abc": PROVED})
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.docker_calls(), [["build", "--tag", TAG, "."]])

    def test_save_prints_exactly_the_id_and_writes_the_archive(self):
        handoff = self.root / "out"
        result = self.run_handoff("save", "obsync-gate-full:abc", str(handoff),
                                  images={"obsync-gate-full:abc": PROVED})
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, PROVED + "\n")
        self.assertTrue((handoff / "image.tar").is_file())
        self.assertEqual(self.verbs(), ["image", "save"])

    def test_an_image_without_a_sha256_id_is_refused(self):
        # The last case is a tag `docker image inspect` cannot find. Bash clears
        # `set -e` inside `$(...)`, so the shape check, not the failed inspect,
        # is what stops it.
        cases = [{"obsync-gate-full:abc": found} for found in ("abc", PROVED.upper(), "", PROVED + "0")]
        for images in cases + [{}]:
            with self.subTest(images=images):
                result = self.run_handoff("save", "obsync-gate-full:abc", str(self.root / "out"),
                                          images=images)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("has no sha256 ID", result.stderr)
                self.assertEqual(result.stdout, "")
                self.assertNotIn("save", self.verbs())

    def test_a_missing_or_extra_argument_is_refused(self):
        for args in (("take", PROVED, "dir"), ("save", "tag"), ("push", "x"), ()):
            with self.subTest(args=args):
                result = self.run_handoff(*args)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("usage:", result.stderr)
                self.assertEqual(self.docker_calls(), [])


if __name__ == "__main__":
    unittest.main()
