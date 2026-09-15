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
different orders or different names, a file that cannot render at all, and a
file over the ceiling the convention sets -- which is the convention's own
proxy for "this is a full-screen capture that wanted cropping", and a
full-screen capture is how the private fact gets in.

WHAT THE FIRST VERSION OF THIS FILE GOT WRONG, because each repair below is
one of its own surviving mutants and the reason the rule is now written the
way it is:

  * THE CEILING COULD BE RAISED WITHOUT A FAILURE. The over-ceiling fixture
    was `b"\\0" * SIZE_CEILING`, generated from the very constant it was meant
    to police, so doubling `SIZE_CEILING` moved the fixture with it and all
    nine tests stayed green. A policy number's test may not be written in
    terms of the policy number. The ceiling is now the literal `409600`,
    asserted against that literal and against the convention's own "400 KB"
    sentence, and the negative fixture is a hard-coded `409601` bytes that no
    edit to the constant can drag along.

  * A CAPTURE COULD BE EIGHT BYTES. The check was `blob.startswith(PNG_MAGIC)`,
    so the eight signature bytes alone passed as an image: no header, no pixel
    data, no terminator, and nothing a browser will draw. A "this is a PNG"
    rule that a file with no PNG in it satisfies is the vacuous assertion the
    review protocol calls a finding. The file is now WALKED -- signature, then
    every chunk's declared length, type, and CRC-32 -- and must be a complete
    image: `IHDR` first with plausible dimensions, at least one `IDAT`, `IEND`
    last, and not one byte after it. The walk is bounded by the file: every
    step advances at least twelve bytes, and a chunk that does not fit is a
    refusal rather than a read past the end.

  * HIDING EVERY SCREENSHOT WAS INVISIBLE. References were counted as raw
    substrings, so wrapping all five image lines in one HTML comment, or
    deleting the `!` that makes a link an image, removed every rendered
    capture from the README while the count stayed five. What is pinned is
    what a READER SEES: HTML comments, fenced blocks and inline code are
    removed first, and only the markdown image form counts.

EVERY RULE HAS A NEGATIVE TEST. `MutatedDocumentsAreRefused` re-runs the same
functions over the real text and the real bytes with one property broken, in
memory, never on disk. Standard library only (requirement 5).
"""

from __future__ import annotations

import re
import struct
import unittest
import zlib
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
# (docs/captures/README.md). 400 KiB is that sentence as a number, written as
# the literal it is: see the module docstring for why it is not `400 * 1024`.
SIZE_CEILING = 409600
# The sentence the ceiling comes from. If the convention stops saying it, the
# number here has lost its source and this suite says so.
CEILING_SENTENCE = "400 KB"
PNG_MAGIC = b"\x89PNG\r\n\x1a\n"
# A chunk is 4 length bytes, 4 type bytes, its body, and 4 CRC bytes.
CHUNK_OVERHEAD = 12
# No screenshot of any screen anyone owns is larger than this on a side. It is
# a sanity bound on a parsed integer, not a policy about displays.
MAX_DIMENSION = 40000

_IMAGE_RE = re.compile(r"!\[[^\]]*\]\(docs/captures/([^)\s]+)\)")
_TABLE_RE = re.compile(r"^\| `([^`]+\.png)` \|", re.MULTILINE)
_HTML_COMMENT_RE = re.compile(r"<!--.*?-->", re.DOTALL)
_FENCED_RE = re.compile(r"^```.*?^```", re.DOTALL | re.MULTILINE)
_INLINE_CODE_RE = re.compile(r"`[^`\n]*`")
_CHUNK_TYPE_RE = re.compile(rb"[A-Za-z]{4}")


def displayed(markdown: str) -> str:
    """The markdown a reader actually sees rendered.

    Order matters: a comment may contain a fence and a fence may contain a
    backtick. Removing the outermost construct first is what keeps a nested
    one from resurfacing as visible text.
    """
    without_comments = _HTML_COMMENT_RE.sub("", markdown)
    without_fences = _FENCED_RE.sub("", without_comments)
    return _INLINE_CODE_RE.sub("", without_fences)


def referenced(readme: str) -> list[str]:
    """Every capture README.md DISPLAYS, in the order it displays them.

    Only the image form counts. A bare link renders as text the reader must
    click, not as the screenshot this section leads with, and a commented-out
    or fenced image renders as nothing at all.
    """
    return _IMAGE_RE.findall(displayed(readme))


def tabled(convention: str) -> list[str]:
    """Every capture the convention's own table names, in its order."""
    return _TABLE_RE.findall(convention)


def png_refusals(name: str, blob: bytes | None) -> list[str]:
    """Refuse anything that is not one complete, self-consistent PNG.

    Every branch returns rather than continuing, because after the first
    inconsistency the offsets this walk computes are no longer meaningful and
    a second message would be a guess. `blob is None` is answered HERE, and
    not only by the caller, so that deleting the caller's own missing-file
    branch still produces this refusal rather than an attribute error on
    `None` -- a guard whose removal crashes has not been proven to refuse.
    """
    if blob is None:
        return [f"{name} is referenced but not committed"]
    if not blob.startswith(PNG_MAGIC):
        return [f"{name} does not begin with the PNG signature"]
    size = len(blob)
    offset = len(PNG_MAGIC)
    types: list[bytes] = []
    dimensions: tuple[int, int] | None = None
    while offset < size:
        if size - offset < CHUNK_OVERHEAD:
            return [f"{name} ends mid-chunk, {size - offset} bytes after byte {offset}"]
        (length,) = struct.unpack(">I", blob[offset : offset + 4])
        kind = blob[offset + 4 : offset + 8]
        if not _CHUNK_TYPE_RE.fullmatch(kind):
            return [
                f"{name} has a chunk at byte {offset} whose type is not four letters"
            ]
        if length > size - offset - CHUNK_OVERHEAD:
            return [
                f"{name} declares a {length}-byte {kind.decode()} chunk at byte "
                f"{offset} that does not fit in {size} bytes"
            ]
        body = blob[offset + 8 : offset + 8 + length]
        (declared,) = struct.unpack(
            ">I", blob[offset + 8 + length : offset + CHUNK_OVERHEAD + length]
        )
        if zlib.crc32(kind + body) & 0xFFFFFFFF != declared:
            return [f"{name} chunk {kind.decode()} at byte {offset} fails its CRC-32"]
        if kind == b"IHDR":
            if length != 13:
                return [f"{name} has a {length}-byte IHDR, which must be 13"]
            dimensions = struct.unpack(">II", body[:8])
        types.append(kind)
        # Every chunk advances the walk by at least CHUNK_OVERHEAD, so this
        # loop is bounded by the file size and cannot spin on a zero-length
        # chunk or read past the end.
        offset += CHUNK_OVERHEAD + length
        if kind == b"IEND":
            break
    if not types:
        return [f"{name} is the PNG signature and nothing else"]
    if types[0] != b"IHDR":
        return [f"{name} begins with {types[0].decode()} rather than IHDR"]
    if dimensions is None or not all(0 < side <= MAX_DIMENSION for side in dimensions):
        return [f"{name} declares implausible dimensions {dimensions}"]
    if b"IDAT" not in types:
        return [f"{name} carries no IDAT chunk, so it has no image in it"]
    if types[-1] != b"IEND":
        return [f"{name} never reaches IEND, so it is truncated"]
    if offset != size:
        return [f"{name} carries {size - offset} bytes after IEND"]
    return []


def refusals(readme: str, convention: str, files: Mapping[str, bytes]) -> list[str]:
    """Every way the capture set goes wrong. Empty means the set is intact."""
    found: list[str] = []
    if referenced(readme) != list(NAMES):
        found.append(
            "README.md must DISPLAY exactly the five captures in order, not "
            f"{referenced(readme)}"
        )
    if tabled(convention) != list(NAMES):
        found.append(
            "docs/captures/README.md must table exactly the five captures in "
            f"order, not {tabled(convention)}"
        )
    if CEILING_SENTENCE not in convention:
        found.append(
            f"docs/captures/README.md no longer states the {CEILING_SENTENCE} "
            f"ceiling this suite pins at {SIZE_CEILING} bytes"
        )
    for name in NAMES:
        blob = files.get(name)
        found.extend(png_refusals(name, blob))
        if blob is not None and len(blob) > SIZE_CEILING:
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


def chunk(kind: bytes, body: bytes) -> bytes:
    return (
        struct.pack(">I", len(body))
        + kind
        + body
        + struct.pack(">I", zlib.crc32(kind + body) & 0xFFFFFFFF)
    )


IHDR = chunk(b"IHDR", struct.pack(">IIBBBBB", 1, 1, 8, 0, 0, 0, 0))
IDAT = chunk(b"IDAT", zlib.compress(b"\x00\x00"))
IEND = chunk(b"IEND", b"")
# One complete one-by-one greyscale PNG, built here rather than committed, so
# every structural case below is a mutation of something this suite ACCEPTS.
TINY_PNG = PNG_MAGIC + IHDR + IDAT + IEND
# The over-ceiling fixture's size, written as a literal that derives from
# nothing: an edit to SIZE_CEILING cannot drag it along.
OVER_CEILING = 409601


def png_of_at_least(size: int) -> bytes:
    """A valid PNG padded to at least `size` bytes by an ancillary chunk."""
    padding = size - len(TINY_PNG) - CHUNK_OVERHEAD - len(b"pad\x00")
    grown = (
        TINY_PNG[: -len(IEND)]
        + chunk(b"tEXt", b"pad\x00" + b"x" * max(padding, 0))
        + IEND
    )
    assert len(grown) >= size, (len(grown), size)
    return grown


class CaptureSetIsIntact(unittest.TestCase):
    def test_the_repository_refuses_nothing(self):
        readme, convention = documents()
        self.assertEqual([], refusals(readme, convention, committed()))

    def test_the_five_are_the_files_on_disk(self):
        self.assertEqual(sorted(NAMES), sorted(committed()))

    def test_the_ceiling_is_the_documented_number(self):
        # The assertion that makes RAISING the ceiling a failing test. Written
        # twice on purpose: the literal a reader checks against the
        # convention, and the arithmetic that says what the literal means.
        self.assertEqual(409600, SIZE_CEILING)
        self.assertEqual(400 * 1024, SIZE_CEILING)
        self.assertEqual(409601, OVER_CEILING)
        self.assertIn(CEILING_SENTENCE, documents()[1])

    def test_the_fixture_pngs_are_accepted(self):
        # Non-vacuity for every structural case below: the thing each one
        # mutates is something this walk actually accepts.
        self.assertEqual([], png_refusals("tiny.png", TINY_PNG))
        self.assertEqual([], png_refusals("padded.png", png_of_at_least(OVER_CEILING)))


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

    # ---- what the README DISPLAYS -----------------------------------------

    def test_dropping_a_readme_image_is_refused(self):
        readme = self.readme.replace(f"](docs/captures/{NAMES[4]})", "]()", 1)
        self.kills(refusals(readme, self.convention, self.files), "in order")

    def test_reordering_the_readme_images_is_refused(self):
        readme = self.readme.replace(
            f"](docs/captures/{NAMES[0]})", f"](docs/captures/{NAMES[1]})", 1
        )
        self.kills(refusals(readme, self.convention, self.files), "in order")

    def test_commenting_out_every_image_is_refused(self):
        marker = f"](docs/captures/{NAMES[4]})"
        first = self.readme.index("![")
        last = self.readme.index(marker) + len(marker)
        readme = (
            self.readme[:first]
            + "<!--\n"
            + self.readme[first:last]
            + "\n-->"
            + self.readme[last:]
        )
        self.assertEqual([], referenced(readme))
        self.kills(refusals(readme, self.convention, self.files), "in order")

    def test_turning_an_image_into_a_link_is_refused(self):
        readme = self.readme.replace("![The recovery-phrase", "[The recovery-phrase", 1)
        self.kills(refusals(readme, self.convention, self.files), "in order")

    def test_fencing_an_image_is_refused(self):
        marker = f"](docs/captures/{NAMES[1]})"
        end = self.readme.index(marker) + len(marker)
        start = self.readme.rindex("![", 0, end)
        readme = (
            self.readme[:start]
            + "```\n"
            + self.readme[start:end]
            + "\n```"
            + self.readme[end:]
        )
        self.kills(refusals(readme, self.convention, self.files), "in order")

    # ---- what the convention tables ---------------------------------------

    def test_dropping_a_convention_row_is_refused(self):
        convention = re.sub(
            rf"^\| `{re.escape(NAMES[2])}` \|.*$",
            "",
            self.convention,
            count=1,
            flags=re.MULTILINE,
        )
        self.kills(
            refusals(self.readme, convention, self.files), "docs/captures/README.md"
        )

    def test_losing_the_ceiling_sentence_is_refused(self):
        convention = self.convention.replace(CEILING_SENTENCE, "some megabytes")
        self.kills(refusals(self.readme, convention, self.files), "no longer states")

    # ---- what is committed ------------------------------------------------

    def test_an_uncommitted_capture_is_refused(self):
        files = {name: blob for name, blob in self.files.items() if name != NAMES[3]}
        found = refusals(self.readme, self.convention, files)
        self.kills(found, "is referenced but not committed")
        self.kills(found, NAMES[3])

    def test_an_unreferenced_capture_is_refused(self):
        files = dict(self.files, **{"06-stray.png": TINY_PNG})
        self.kills(refusals(self.readme, self.convention, files), "referenced nowhere")

    def test_a_capture_over_the_ceiling_is_refused(self):
        files = dict(self.files, **{NAMES[0]: png_of_at_least(OVER_CEILING)})
        self.kills(refusals(self.readme, self.convention, files), "ceiling")

    # ---- what a capture must BE -------------------------------------------

    def test_a_capture_that_is_not_a_png_is_refused(self):
        files = dict(self.files, **{NAMES[1]: b"GIF89a" + b"\0" * 64})
        self.kills(refusals(self.readme, self.convention, files), "PNG signature")

    def test_a_signature_only_capture_is_refused(self):
        files = dict(self.files, **{NAMES[0]: PNG_MAGIC})
        self.kills(
            refusals(self.readme, self.convention, files), "signature and nothing else"
        )

    def test_a_capture_truncated_after_ihdr_is_refused(self):
        files = dict(self.files, **{NAMES[2]: PNG_MAGIC + IHDR})
        self.kills(refusals(self.readme, self.convention, files), "no IDAT chunk")

    def test_a_capture_with_no_iend_is_refused(self):
        files = dict(self.files, **{NAMES[3]: PNG_MAGIC + IHDR + IDAT})
        self.kills(refusals(self.readme, self.convention, files), "never reaches IEND")

    def test_a_capture_with_a_corrupt_crc_is_refused(self):
        broken = bytearray(TINY_PNG)
        broken[len(PNG_MAGIC) + len(IHDR) - 1] ^= 0xFF
        files = dict(self.files, **{NAMES[4]: bytes(broken)})
        self.kills(refusals(self.readme, self.convention, files), "fails its CRC-32")

    def test_a_capture_with_trailing_bytes_is_refused(self):
        files = dict(self.files, **{NAMES[0]: TINY_PNG + b"appended"})
        self.kills(refusals(self.readme, self.convention, files), "bytes after IEND")

    def test_a_capture_with_an_overlong_chunk_length_is_refused(self):
        broken = bytearray(TINY_PNG)
        struct.pack_into(">I", broken, len(PNG_MAGIC), 1 << 30)
        files = dict(self.files, **{NAMES[1]: bytes(broken)})
        self.kills(refusals(self.readme, self.convention, files), "does not fit")

    def test_a_capture_ending_mid_chunk_is_refused(self):
        files = dict(self.files, **{NAMES[2]: TINY_PNG[:-4]})
        self.kills(refusals(self.readme, self.convention, files), "ends mid-chunk")

    def test_a_capture_with_a_non_letter_chunk_type_is_refused(self):
        broken = bytearray(TINY_PNG)
        broken[len(PNG_MAGIC) + 4] = 0x31
        files = dict(self.files, **{NAMES[3]: bytes(broken)})
        self.kills(refusals(self.readme, self.convention, files), "not four letters")

    def test_a_capture_with_zero_dimensions_is_refused(self):
        header = chunk(b"IHDR", struct.pack(">IIBBBBB", 0, 1, 8, 0, 0, 0, 0))
        files = dict(self.files, **{NAMES[4]: PNG_MAGIC + header + IDAT + IEND})
        self.kills(
            refusals(self.readme, self.convention, files), "implausible dimensions"
        )


if __name__ == "__main__":
    unittest.main()
