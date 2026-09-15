"""The five README captures are a control, not a caption.

WHY. `docs/captures/README.md` says "README.md references exactly these names,
in this order". Nothing enforced it. The sentence was deleted from README.md in
a scratch copy -- one image reference removed, nothing else -- and all 519
contract tests stayed green, exactly the shape `test_onboarding_contract.py`
was written for one document earlier: prose that is a control needs a control.

The captures are also the one place in this repository where requirement 11 is
enforced on PIXELS rather than on text, and the review that superseded pull
request #66 found a device-identifier fragment in one of them. A suite cannot
read pixels, but it can pin the things that go silently wrong around them: a
capture that is referenced and not committed (the README renders a broken
image to every reader), a capture that is committed and not referenced (an
unreviewed image published for nothing), the two documents drifting into
different orders or different names, and a file that grew past the ceiling the
convention sets, which is the convention's own proxy for "this is a
full-screen capture that wanted cropping" -- and a full-screen capture is how
the private fact gets in.

EVERY RULE HAS A NEGATIVE TEST. `MutatedDocumentsAreRefused` re-runs the same
function over the real text with one property broken, in memory, never on
disk. Standard library only (requirement 5).
"""

from __future__ import annotations

import re
import unittest
from pathlib import Path
from typing import Mapping

ROOT = Path(__file__).resolve().parents[2]
CAPTURES = ROOT / "docs" / "captures"
README = ROOT / "README.md"
CONVENTION = CAPTURES / "README.md"

# The five, in the order the README walks a reader through them. Changing this
# tuple is changing the README, which is the point of writing it down once.
NAMES = (
    "01-install-from-directory.png",
    "02-first-time-setup.png",
    "03-recovery-phrase.png",
    "04-pair-a-new-device.png",
    "05-sync-both-ways.png",
)
# "A capture over about 400 KB is a full-screen capture that wanted cropping"
# (docs/captures/README.md). 400 KiB is that sentence as a number.
SIZE_CEILING = 400 * 1024
PNG_MAGIC = b"\x89PNG\r\n\x1a\n"
_REFERENCE_RE = re.compile(r"\]\(docs/captures/([^)\s]+)\)")
_TABLE_RE = re.compile(r"^\| `([^`]+\.png)` \|", re.MULTILINE)


def referenced(readme: str) -> list[str]:
    """Every capture README.md points at, in the order it points at them."""
    return _REFERENCE_RE.findall(readme)


def tabled(convention: str) -> list[str]:
    """Every capture the convention's own table names, in its order."""
    return _TABLE_RE.findall(convention)


def refusals(readme: str, convention: str, files: Mapping[str, bytes]) -> list[str]:
    """Every way the capture set goes wrong. Empty means the set is intact."""
    found: list[str] = []
    if referenced(readme) != list(NAMES):
        found.append(
            "README.md must reference exactly the five captures in order, not "
            f"{referenced(readme)}"
        )
    if tabled(convention) != list(NAMES):
        found.append(
            "docs/captures/README.md must table exactly the five captures in "
            f"order, not {tabled(convention)}"
        )
    for name in NAMES:
        blob = files.get(name)
        if blob is None:
            found.append(f"{name} is referenced but not committed")
            continue
        if not blob.startswith(PNG_MAGIC):
            found.append(f"{name} is not a PNG")
        if len(blob) > SIZE_CEILING:
            found.append(
                f"{name} is {len(blob)} bytes, over the {SIZE_CEILING}-byte ceiling"
            )
    for name in sorted(set(files) - set(NAMES)):
        found.append(f"{name} is committed under docs/captures/ but referenced nowhere")
    return found


def committed() -> dict[str, bytes]:
    return {path.name: path.read_bytes() for path in sorted(CAPTURES.glob("*.png"))}


def documents() -> tuple[str, str]:
    return README.read_text(encoding="utf-8"), CONVENTION.read_text(encoding="utf-8")


class CaptureSetIsIntact(unittest.TestCase):
    def test_the_repository_refuses_nothing(self):
        readme, convention = documents()
        self.assertEqual([], refusals(readme, convention, committed()))

    def test_the_five_are_the_files_on_disk(self):
        self.assertEqual(sorted(NAMES), sorted(committed()))


class MutatedDocumentsAreRefused(unittest.TestCase):
    def setUp(self):
        self.readme, self.convention = documents()
        self.files = committed()
        self.assertEqual([], refusals(self.readme, self.convention, self.files))

    def kills(self, found: list[str], needle: str) -> None:
        self.assertTrue(
            [line for line in found if needle in line],
            f"{needle!r} was not refused after the mutation: {found}",
        )

    def test_dropping_a_readme_reference_is_refused(self):
        readme = self.readme.replace(f"](docs/captures/{NAMES[4]})", "]()", 1)
        self.kills(refusals(readme, self.convention, self.files), "in order")

    def test_reordering_the_readme_references_is_refused(self):
        readme = self.readme.replace(
            f"](docs/captures/{NAMES[0]})", f"](docs/captures/{NAMES[1]})", 1
        )
        self.kills(refusals(readme, self.convention, self.files), "in order")

    def test_dropping_a_convention_row_is_refused(self):
        convention = re.sub(
            rf"^\| `{re.escape(NAMES[2])}` \|.*$", "", self.convention, count=1,
            flags=re.MULTILINE,
        )
        self.kills(refusals(self.readme, convention, self.files), "docs/captures/README.md")

    def test_an_uncommitted_capture_is_refused(self):
        files = {name: blob for name, blob in self.files.items() if name != NAMES[3]}
        self.kills(refusals(self.readme, self.convention, files), "not committed")

    def test_an_unreferenced_capture_is_refused(self):
        files = dict(self.files, **{"06-stray.png": PNG_MAGIC})
        self.kills(refusals(self.readme, self.convention, files), "referenced nowhere")

    def test_a_capture_over_the_ceiling_is_refused(self):
        files = dict(self.files, **{NAMES[0]: PNG_MAGIC + b"\0" * SIZE_CEILING})
        self.kills(refusals(self.readme, self.convention, files), "ceiling")

    def test_a_capture_that_is_not_a_png_is_refused(self):
        files = dict(self.files, **{NAMES[1]: b"GIF89a"})
        self.kills(refusals(self.readme, self.convention, files), "is not a PNG")


if __name__ == "__main__":
    unittest.main()
