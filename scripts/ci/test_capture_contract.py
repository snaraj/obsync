r"""The five README captures are a control, not a caption.

WHY. `docs/captures/README.md` says "README.md references exactly these names,
in this order". Nothing enforced it. The sentence was deleted from README.md in
a scratch copy -- one image reference removed, nothing else -- and all 519
contract tests stayed green, exactly the shape `test_onboarding_contract.py`
was written for one document earlier: prose that is a control needs a control.

The captures are also the one place in this repository where requirement 11 is
enforced on PIXELS rather than on text, and the review that superseded pull
request #66 found a device-identifier fragment in one of them. No suite reads
pixels. This one reads everything around them.

WHAT THIS SUITE ESTABLISHES, exactly and only:

  1. FRAMING AND INTEGRITY. Each committed capture is a PNG datastream whose
     signature, chunk lengths, four-letter chunk types and CRC-32 values are
     self-consistent, with `IHDR` first, `IEND` last and empty, and no byte
     after it.
  2. A DECODABLE GRID OF THE DECLARED SIZE. The header's colour type, bit
     depth, compression method, filter method and interlace method name one
     supported form; the concatenated `IDAT` bodies are one complete deflate
     stream with nothing after it; and it inflates to EXACTLY
     `height * (1 + rowbytes)` bytes with a legal filter byte (0-4) leading
     every row. It does not decode pixels: the grid is the property, and the
     point is that a file which cannot produce one is refused.
  3. THE SIZE CEILING. Each capture is at most 409,600 bytes, and the
     convention still states the sentence that number comes from.
  4. THE README'S DECLARED FORM. Inside one bounded section of README.md the
     five captures are displayed, each alone on its line, in the convention's
     order, with non-empty alternative text, and none of the constructs that
     turn an image into literal text appears anywhere in that section.
  5. SET EQUALITY. What `docs/captures/` holds, what README.md displays, and
     what the convention's table names are the same five names in the same
     order -- no extra committed capture, no missing one.

It establishes nothing about what the images CONTAIN. Requirement 11 on the
pixels is a human reading every region before the commit, recorded in the pull
request; this file cannot and does not stand in for it.

THE DECLARED DOCUMENT FORM, and why it is a form rather than a markdown
parser. Three versions of this rule have been walked through. The first
counted `](docs/captures/...)` as a raw substring, so an HTML comment around
the five lines hid every screenshot with the count unchanged. The second
stripped comments, column-zero fences and inline code, and a `~~~` fence, an
escaped `\!`, and a `<pre>` walked through that. The third bounded a section
and declared what may stand in it -- and an HTML comment opened on the line
ABOVE the heading hid the whole section from outside the lines being read,
eight spaces turned each image into an indented code block, and `<PRE>` in
capitals matched nothing. "What markdown renders" is a specification this
repository is not going to reimplement in a contract suite, so the form stays
declared and narrow, but it is now read in the document's own visible context:

  * EVERY HTML COMMENT IS REMOVED FROM THE WHOLE FILE FIRST, closed
    (`<!--` to `-->`) or unclosed and running to the end of it, and the
    heading must still be there afterwards. A heading absent from the visible
    document is a README with no screenshots in it, and that is a refusal, not
    a fallback to counting nothing.
  * THE SECTION is the lines from `## Get synced in five steps` to the next
    line beginning `## `, in that visible text.
  * EACH IMAGE LINE is indented by EXACTLY the three spaces that continue its
    numbered list item, carries alternative text that is not empty, and ends
    at the closing parenthesis. Four spaces or a tab open an indented code
    block in CommonMark whatever they contain, so any line of the section
    starting with one is refused on its own.
  * A BACKTICK, a `~~~` fence, a `<pre`, an HTML comment opener, an escaped
    bang or an `<img` is refused wherever it appears in the section, matched
    WITHOUT CASE, because `<PRE>` hides an image exactly as well as `<pre>`.

A construct nobody has thought of yet is refused too, because one anchored
pattern admits a line and nothing else admits one. `docs/captures/README.md`
states the same form, so the rule is readable where the captures are
documented.

EVERY RULE HAS A NEGATIVE TEST, and every negative has a POSITIVE TWIN: the
malformed fixture is a mutation of a datastream this suite accepts, so no
refusal can be passing for the wrong reason. Mutations happen in memory, never
on disk. A guard whose removal raises instead of refusing is not proven, so
every mutation runs through `refusing()`, which turns an exception into a
named assertion failure. Standard library only (requirement 5).
"""

from __future__ import annotations

import re
import struct
import unittest
import zlib
from pathlib import Path
from typing import Mapping, Sequence

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
# the literal it is: a policy number's test may not be written in terms of the
# policy number, or raising the policy raises the test with it.
SIZE_CEILING = 409600
# The sentence the ceiling comes from. If the convention stops saying it, the
# number here has lost its source and this suite says so.
CEILING_SENTENCE = "400 KB"

# ---- the declared README form --------------------------------------------

CAPTURE_SECTION = "## Get synced in five steps"
# Constructs that turn an image into literal text, or smuggle one past an
# anchored pattern. Refused wherever they appear in the capture section, and
# matched WITHOUT CASE: `<PRE>` hides an image exactly as well as `<pre>`.
# An HTML comment opener is NOT in this list, and that is deliberate:
# `visible()` has already removed every comment from the whole file, so
# such a token can never reach this section. An entry here would be a
# control that cannot fire, which is the thing this file keeps deleting.
FORBIDDEN_IN_SECTION = ("`", "~~~", "<pre", "\\!", "<img")
# One image, alone on its line, indented by exactly the three spaces that
# continue a numbered list item, with alternative text that is not empty and
# no trailing whitespace. Eight spaces would make it an indented code block.
IMAGE_LINE_RE = re.compile(
    r"^ {3}!\[[^\]]+\]\(docs/captures/(0[1-5]-[a-z0-9-]+\.png)\)$"
)
# Four spaces or a tab open an indented code block in CommonMark, whatever
# they contain. No line of this section may start one.
INDENTED_CODE_RE = re.compile(r"^(?: {4}|\t)")
# Any other way a line can mention a capture: a link with no bang, an image
# with empty alternative text, an image sharing its line with prose.
MENTION = "](docs/captures/"
# An HTML comment, closed or running to the end of the file. The second shape
# matters because an unclosed opener hides everything after it, and a reader
# of the rendered page sees exactly nothing from that point on.
_CLOSED_COMMENT_RE = re.compile(r"<!--.*?-->", re.DOTALL)
_UNCLOSED_COMMENT_RE = re.compile(r"<!--.*\Z", re.DOTALL)

# ---- the declared PNG form -----------------------------------------------

PNG_MAGIC = b"\x89PNG\r\n\x1a\n"
# A chunk is 4 length bytes, 4 type bytes, its body, and 4 CRC bytes.
CHUNK_OVERHEAD = 12
IHDR_LENGTH = 13
# Colour type -> (the bit depths PNG allows with it, samples per pixel).
# Anything outside this table -- colour type 5 or 7, bit depth 3, 16-bit
# palette -- is refused rather than guessed at.
COLOUR_FORMS: dict[int, tuple[frozenset[int], int]] = {
    0: (frozenset({1, 2, 4, 8, 16}), 1),  # greyscale
    2: (frozenset({8, 16}), 3),  # truecolour
    3: (frozenset({1, 2, 4, 8}), 1),  # indexed, requires PLTE before IDAT
    4: (frozenset({8, 16}), 2),  # greyscale with alpha
    6: (frozenset({8, 16}), 4),  # truecolour with alpha
}
# PLTE holds 1..256 three-byte entries.
MAX_PALETTE_BYTES = 768
# No screenshot of any screen anyone owns is larger than this on a side. It is
# a sanity bound on a parsed integer, not a policy about displays.
MAX_DIMENSION = 40000
# The inflate budget. A header may declare a grid far larger than the file that
# carries it, and this suite must not be the thing that tries to allocate it.
# 64 MiB, written as the literal it is, for the same reason as SIZE_CEILING.
MAX_IMAGE_BYTES = 67108864
# Compressed input is fed in pieces this size, with the OUTPUT bounded per
# call, so a small file declaring an enormous grid cannot inflate past budget.
INFLATE_PIECE = 65536
_CHUNK_TYPE_RE = re.compile(rb"[A-Za-z]{4}")


def visible(readme: str) -> str:
    """README.md with every HTML comment gone, closed or not.

    The whole document, not the section: the reproducer that closed the last
    round put `<!--` on the line ABOVE the heading and `-->` below the last
    image, so the opener sat outside the inspected lines and every screenshot
    vanished with the section itself unchanged. A section cannot be read
    without the context that decides whether it renders at all.
    """
    return _UNCLOSED_COMMENT_RE.sub("", _CLOSED_COMMENT_RE.sub("", readme))


def capture_section(readme: str) -> list[str] | None:
    """The declared bounded section as a READER sees it, or None if hidden."""
    lines = visible(readme).splitlines()
    try:
        start = lines.index(CAPTURE_SECTION)
    except ValueError:
        return None
    end = len(lines)
    for index in range(start + 1, len(lines)):
        if lines[index].startswith("## "):
            end = index
            break
    return lines[start:end]


def displayed_names(section: Sequence[str]) -> list[str]:
    """Every capture the section DISPLAYS, in the order it displays them."""
    return [
        match.group(1)
        for match in (IMAGE_LINE_RE.match(line) for line in section)
        if match
    ]


def section_refusals(readme: str) -> list[str]:
    """Refuse anything but the declared form inside the capture section."""
    section = capture_section(readme)
    if section is None:
        # Not a fallback and not a shrug: a heading that is absent from the
        # visible document is a README with no screenshots in it.
        return [
            f"the capture section `{CAPTURE_SECTION}` is hidden or missing from "
            "the visible README"
        ]
    found: list[str] = []
    lowered = [token.lower() for token in FORBIDDEN_IN_SECTION]
    for offset, line in enumerate(section):
        for token, needle in zip(FORBIDDEN_IN_SECTION, lowered):
            if needle in line.lower():
                found.append(
                    f"the capture section carries {token!r} on its line {offset}, "
                    "which can render an image as literal text"
                )
        if INDENTED_CODE_RE.match(line):
            found.append(
                f"the capture section indents its line {offset} by four spaces or "
                "a tab, which opens an indented code block"
            )
        if IMAGE_LINE_RE.match(line) is None and MENTION in line:
            found.append(
                f"the capture section names a capture on its line {offset} in a "
                f"form the declared one does not admit: {line.strip()!r}"
            )
    shown = displayed_names(section)
    if shown != list(NAMES):
        found.append(
            "the capture section must DISPLAY exactly the five captures, each "
            f"alone on its line, in order, not {shown}"
        )
    return found


def tabled(convention: str) -> list[str]:
    """Every capture the convention's own table names, in its order."""
    return re.findall(r"^\| `([^`]+\.png)` \|", convention, re.MULTILINE)


def _chunks(name: str, blob: bytes) -> tuple[list[tuple[bytes, bytes]], list[str]]:
    """Walk the datastream into chunks, or say why it is not one.

    Framing only: lengths that fit, four-letter types, CRC-32 over type and
    body, IHDR first, IEND last, nothing after it. What the chunks MEAN is
    `_image`'s question.
    """
    size = len(blob)
    offset = len(PNG_MAGIC)
    chunks: list[tuple[bytes, bytes]] = []
    while offset < size:
        if size - offset < CHUNK_OVERHEAD:
            return [], [
                f"{name} ends mid-chunk, {size - offset} bytes after byte {offset}"
            ]
        (length,) = struct.unpack(">I", blob[offset : offset + 4])
        kind = blob[offset + 4 : offset + 8]
        if not _CHUNK_TYPE_RE.fullmatch(kind):
            return [], [
                f"{name} has a chunk at byte {offset} whose type is not four letters"
            ]
        if length > size - offset - CHUNK_OVERHEAD:
            return [], [
                f"{name} declares a {length}-byte {kind.decode()} chunk at byte "
                f"{offset} that does not fit in {size} bytes"
            ]
        body = blob[offset + 8 : offset + 8 + length]
        (declared,) = struct.unpack(
            ">I", blob[offset + 8 + length : offset + CHUNK_OVERHEAD + length]
        )
        if zlib.crc32(kind + body) & 0xFFFFFFFF != declared:
            return [], [f"{name} chunk {kind.decode()} at byte {offset} fails its CRC-32"]
        chunks.append((kind, body))
        # Every chunk advances the walk by at least CHUNK_OVERHEAD, so this
        # loop is bounded by the file size and cannot spin on a zero-length
        # chunk or read past the end.
        offset += CHUNK_OVERHEAD + length
        if kind == b"IEND":
            break
    if not chunks:
        return [], [f"{name} is the PNG signature and nothing else"]
    if chunks[0][0] != b"IHDR":
        return [], [f"{name} begins with {chunks[0][0].decode()} rather than IHDR"]
    if chunks[-1][0] != b"IEND":
        return [], [f"{name} never reaches IEND, so it is truncated"]
    if offset != size:
        return [], [f"{name} carries {size - offset} bytes after IEND"]
    return chunks, []


def _inflate(name: str, stream: bytes, expected: int) -> tuple[bytes, list[str]]:
    """Inflate the IDAT stream under a hard output budget."""
    budget = expected + 1
    decompressor = zlib.decompressobj()
    out = bytearray()
    pending = stream
    try:
        while pending and len(out) < budget and not decompressor.eof:
            feed, pending = pending[:INFLATE_PIECE], pending[INFLATE_PIECE:]
            # max_length is never 0 here: zlib reads 0 as "no limit", and the
            # loop condition keeps `budget - len(out)` at 1 or more. Input the
            # call could not consume is not fed back: that only happens when
            # the output hit the budget, and a stream that reaches the budget
            # is refused two lines below rather than inflated further.
            out += decompressor.decompress(feed, budget - len(out))
    except zlib.error as error:
        return b"", [f"{name} IDAT data is not a valid deflate stream ({error})"]
    if len(out) > expected:
        return b"", [
            f"{name} IDAT data inflates past the {expected} bytes its header "
            "declares"
        ]
    if not decompressor.eof:
        return b"", [
            f"{name} IDAT deflate stream never terminates; it yielded "
            f"{len(out)} of the {expected} bytes its header declares"
        ]
    trailing = len(decompressor.unused_data) + len(pending)
    if trailing:
        return b"", [f"{name} carries {trailing} bytes after the IDAT deflate stream"]
    if len(out) != expected:
        return b"", [
            f"{name} IDAT data inflates to {len(out)} bytes, not the {expected} "
            "its header declares"
        ]
    return bytes(out), []


def _image(name: str, chunks: Sequence[tuple[bytes, bytes]]) -> list[str]:
    """Refuse a framed datastream that is not one decodable image."""
    kinds = [kind for kind, _ in chunks]
    if kinds.count(b"IHDR") != 1:
        return [f"{name} carries {kinds.count(b'IHDR')} IHDR chunks, which must be 1"]
    if len(chunks[0][1]) != IHDR_LENGTH:
        return [
            f"{name} has a {len(chunks[0][1])}-byte IHDR, which must be {IHDR_LENGTH}"
        ]
    width, height, depth, colour, compression, filtering, interlace = struct.unpack(
        ">IIBBBBB", chunks[0][1]
    )
    if not all(0 < side <= MAX_DIMENSION for side in (width, height)):
        return [f"{name} declares implausible dimensions {(width, height)}"]
    if compression != 0:
        return [f"{name} declares compression method {compression}; PNG defines 0"]
    if filtering != 0:
        return [f"{name} declares filter method {filtering}; PNG defines 0"]
    if interlace != 0:
        return [
            f"{name} declares interlace method {interlace}; this form supports 0, "
            "and a screenshot is never interlaced"
        ]
    if colour not in COLOUR_FORMS:
        return [f"{name} declares colour type {colour}, which PNG does not define"]
    depths, channels = COLOUR_FORMS[colour]
    if depth not in depths:
        return [
            f"{name} declares bit depth {depth} with colour type {colour}, which "
            f"allows {sorted(depths)}"
        ]
    if b"IDAT" not in kinds:
        return [f"{name} carries no IDAT chunk, so it has no image in it"]
    first_idat = kinds.index(b"IDAT")
    last_idat = len(kinds) - 1 - kinds[::-1].index(b"IDAT")
    if any(kind != b"IDAT" for kind in kinds[first_idat : last_idat + 1]):
        return [f"{name} has a non-IDAT chunk between its IDAT chunks"]
    palettes = [index for index, kind in enumerate(kinds) if kind == b"PLTE"]
    if len(palettes) > 1:
        return [f"{name} carries {len(palettes)} PLTE chunks, which must be at most 1"]
    if palettes and colour in (0, 4):
        return [f"{name} carries a PLTE chunk with greyscale colour type {colour}"]
    if colour == 3 and (not palettes or palettes[0] > first_idat):
        return [f"{name} has colour type 3 with no PLTE chunk before its first IDAT"]
    if palettes:
        palette = chunks[palettes[0]][1]
        if not palette or len(palette) % 3 or len(palette) > MAX_PALETTE_BYTES:
            return [f"{name} has a {len(palette)}-byte PLTE chunk, which must be 3 to "
                    f"{MAX_PALETTE_BYTES} bytes in three-byte entries"]
        if colour == 3 and len(palette) // 3 > 1 << depth:
            return [
                f"{name} has {len(palette) // 3} palette entries, more than the "
                f"{1 << depth} its {depth}-bit indices can name"
            ]
    if chunks[-1][1]:
        return [f"{name} has a {len(chunks[-1][1])}-byte IEND, which must be empty"]
    rowbytes = -(-(width * channels * depth) // 8)
    expected = height * (1 + rowbytes)
    if expected > MAX_IMAGE_BYTES:
        return [
            f"{name} declares a {expected}-byte grid, over the {MAX_IMAGE_BYTES}-byte "
            "budget this suite will inflate"
        ]
    raw, refused = _inflate(
        name, b"".join(body for kind, body in chunks if kind == b"IDAT"), expected
    )
    if refused:
        return refused
    for row in range(height):
        filter_byte = raw[row * (1 + rowbytes)]
        if filter_byte > 4:
            return [
                f"{name} row {row} carries filter byte {filter_byte}; PNG defines 0 to 4"
            ]
    return []


def png_refusals(name: str, blob: bytes | None) -> list[str]:
    """Refuse anything that is not one complete, decodable PNG.

    `blob is None` is answered HERE, and not only by the caller, so that
    deleting the caller's own missing-file branch still produces this refusal
    rather than an attribute error on `None`.
    """
    if blob is None:
        return [f"{name} is referenced but not committed"]
    if not blob.startswith(PNG_MAGIC):
        return [f"{name} does not begin with the PNG signature"]
    chunks, refused = _chunks(name, blob)
    if refused:
        return refused
    return _image(name, chunks)


def refusals(readme: str, convention: str, files: Mapping[str, bytes]) -> list[str]:
    """Every way the capture set goes wrong. Empty means the set is intact."""
    found = section_refusals(readme)
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


# ---- fixtures: every negative below is a mutation of one of these ----------


def chunk(kind: bytes, body: bytes) -> bytes:
    return (
        struct.pack(">I", len(body))
        + kind
        + body
        + struct.pack(">I", zlib.crc32(kind + body) & 0xFFFFFFFF)
    )


def ihdr(
    width: int = 1,
    height: int = 1,
    depth: int = 8,
    colour: int = 0,
    compression: int = 0,
    filtering: int = 0,
    interlace: int = 0,
) -> bytes:
    return chunk(
        b"IHDR",
        struct.pack(
            ">IIBBBBB", width, height, depth, colour, compression, filtering, interlace
        ),
    )


def rows(
    width: int = 1, height: int = 1, depth: int = 8, colour: int = 0, filter_byte: int = 0
) -> bytes:
    """The raw filtered scanlines a grid of this shape must inflate to."""
    rowbytes = -(-(width * COLOUR_FORMS[colour][1] * depth) // 8)
    return bytes([filter_byte] + [0] * rowbytes) * height


def assemble(*parts: bytes, iend: bytes = b"") -> bytes:
    return PNG_MAGIC + b"".join(parts) + chunk(b"IEND", iend)


GREY = assemble(ihdr(), chunk(b"IDAT", zlib.compress(rows())))
RGB = assemble(
    ihdr(2, 2, 8, 2), chunk(b"IDAT", zlib.compress(rows(2, 2, 8, 2)))
)
INDEXED = assemble(
    ihdr(4, 2, 2, 3),
    chunk(b"PLTE", bytes(12)),
    chunk(b"IDAT", zlib.compress(rows(4, 2, 2, 3))),
)
GREY_ALPHA = assemble(
    ihdr(2, 2, 16, 4), chunk(b"IDAT", zlib.compress(rows(2, 2, 16, 4)))
)
RGBA = assemble(
    ihdr(3, 3, 8, 6), chunk(b"IDAT", zlib.compress(rows(3, 3, 8, 6)))
)
_SPLIT = zlib.compress(rows(8, 8, 8, 6))
MULTI_IDAT = assemble(
    ihdr(8, 8, 8, 6),
    chunk(b"IDAT", _SPLIT[: len(_SPLIT) // 2]),
    chunk(b"IDAT", _SPLIT[len(_SPLIT) // 2 :]),
)
FULL_PALETTE = assemble(
    ihdr(4, 2, 8, 3),
    chunk(b"PLTE", bytes(MAX_PALETTE_BYTES)),
    chunk(b"IDAT", zlib.compress(rows(4, 2, 8, 3))),
)
POSITIVES = {
    "grey.png": GREY,
    "full-palette.png": FULL_PALETTE,
    "rgb.png": RGB,
    "indexed.png": INDEXED,
    "grey-alpha.png": GREY_ALPHA,
    "rgba.png": RGBA,
    "multi-idat.png": MULTI_IDAT,
}
# The over-ceiling fixture's size, written as a literal that derives from
# nothing: an edit to SIZE_CEILING cannot drag it along.
OVER_CEILING = 409601


def png_of_at_least(size: int) -> bytes:
    """A complete, decodable PNG padded past `size` by an ancillary chunk."""
    padding = size - len(GREY) - CHUNK_OVERHEAD - len(b"pad\x00")
    grown = assemble(
        ihdr(),
        chunk(b"tEXt", b"pad\x00" + b"x" * max(padding, 0)),
        chunk(b"IDAT", zlib.compress(rows())),
    )
    assert len(grown) >= size, (len(grown), size)
    return grown


class CaptureSetIsIntact(unittest.TestCase):
    def test_the_repository_refuses_nothing(self):
        readme, convention = documents()
        self.assertEqual([], refusals(readme, convention, committed()))

    def test_the_five_are_the_files_on_disk(self):
        self.assertEqual(sorted(NAMES), sorted(committed()))

    def test_the_policy_numbers_are_the_documented_ones(self):
        # The assertions that make RAISING a bound a failing test. Each is
        # written against a literal, never against the constant it polices.
        self.assertEqual(409600, SIZE_CEILING)
        self.assertEqual(400 * 1024, SIZE_CEILING)
        self.assertEqual(409601, OVER_CEILING)
        self.assertEqual(40000, MAX_DIMENSION)
        self.assertEqual(67108864, MAX_IMAGE_BYTES)
        self.assertEqual(64 * 1024 * 1024, MAX_IMAGE_BYTES)
        self.assertEqual(768, MAX_PALETTE_BYTES)
        self.assertEqual(256 * 3, MAX_PALETTE_BYTES)
        self.assertIn(CEILING_SENTENCE, documents()[1])

    def test_the_declared_form_is_stated_where_the_captures_are_documented(self):
        convention = documents()[1]
        self.assertIn(CAPTURE_SECTION, convention)
        for token in FORBIDDEN_IN_SECTION:
            self.assertIn(token, convention, f"the convention does not name {token!r}")

    def test_every_positive_fixture_is_accepted(self):
        # Non-vacuity for every structural case below: each mutates one of
        # these, and each of these is a datastream this suite accepts.
        for name, blob in POSITIVES.items():
            with self.subTest(fixture=name):
                self.assertEqual([], png_refusals(name, blob))
        self.assertEqual([], png_refusals("padded.png", png_of_at_least(OVER_CEILING)))


class MutatedDocumentsAreRefused(unittest.TestCase):
    def setUp(self):
        self.readme, self.convention = documents()
        self.files = committed()
        self.assertEqual([], refusals(self.readme, self.convention, self.files))

    def refusing(self, readme, convention, files, case: str) -> list[str]:
        """Run the control, turning any exception into a named failure.

        A guard whose removal raises has not been shown to refuse anything.
        This is where that distinction is enforced, so the three removals the
        review found dying by exception -- a missing blob, a chunk list that
        never filled, the declared-length bound -- fail with a message.
        """
        try:
            return refusals(readme, convention, files)
        except Exception as error:  # noqa: BLE001 - the point is to name it
            self.fail(f"the capture control raised {error!r} on {case} instead of refusing it")

    def kills(self, found: list[str], needle: str) -> None:
        self.assertTrue(
            [line for line in found if needle in line],
            f"{needle!r} was not refused after the mutation: {found}",
        )

    def with_capture(self, name: str, blob: bytes, needle: str, case: str) -> None:
        files = dict(self.files, **{name: blob})
        self.kills(self.refusing(self.readme, self.convention, files, case), needle)

    def with_readme(self, readme: str, needle: str, case: str) -> None:
        self.kills(self.refusing(readme, self.convention, self.files, case), needle)

    # ---- the declared README form -----------------------------------------

    def section_span(self) -> tuple[int, int]:
        lines = self.readme.splitlines()
        start = lines.index(CAPTURE_SECTION)
        end = next(
            index
            for index in range(start + 1, len(lines))
            if lines[index].startswith("## ")
        )
        return start, end

    def rewrite_section(self, rewrite) -> str:
        lines = self.readme.splitlines()
        start, end = self.section_span()
        return "\n".join(lines[:start] + rewrite(lines[start:end]) + lines[end:]) + "\n"

    def test_dropping_a_readme_image_is_refused(self):
        readme = self.readme.replace(f"](docs/captures/{NAMES[4]})", "]()", 1)
        self.with_readme(readme, "in order", "a dropped image")

    def test_reordering_the_readme_images_is_refused(self):
        readme = self.readme.replace(
            f"](docs/captures/{NAMES[0]})", f"](docs/captures/{NAMES[1]})", 1
        )
        self.with_readme(readme, "in order", "reordered images")

    def test_commenting_out_every_image_is_refused(self):
        def rewrite(section):
            # After the heading, so the comment opens INSIDE the section.
            return [section[0], "<!--"] + section[1:] + ["-->"]

        self.with_readme(
            self.rewrite_section(rewrite), "in order", "HTML-commented images"
        )

    def test_a_comment_enclosing_the_whole_section_is_refused(self):
        # The reproducer that survived round 3: the opener sits OUTSIDE the
        # section, so nothing inside it changes and every screenshot is gone.
        readme = self.readme.replace(
            CAPTURE_SECTION, "<!--\n" + CAPTURE_SECTION, 1
        ).replace("## Get syncing\n", "-->\n\n## Get syncing\n", 1)
        self.with_readme(readme, "hidden or missing", "a comment around the section")

    def test_an_unclosed_comment_before_the_section_is_refused(self):
        readme = self.readme.replace(CAPTURE_SECTION, "<!--\n" + CAPTURE_SECTION, 1)
        self.with_readme(
            readme, "hidden or missing", "an unclosed comment above the section"
        )

    def test_eight_space_indented_images_are_refused(self):
        def rewrite(section):
            return [
                "     " + line if IMAGE_LINE_RE.match(line) else line
                for line in section
            ]

        found = self.refusing(
            self.rewrite_section(rewrite), self.convention, self.files, "indented images"
        )
        self.kills(found, "indented code block")
        self.kills(found, "in order")

    def test_a_tab_indented_image_is_refused(self):
        def rewrite(section):
            return [
                "\t" + line.lstrip(" ") if IMAGE_LINE_RE.match(line) else line
                for line in section
            ]

        self.kills(
            self.refusing(
                self.rewrite_section(rewrite),
                self.convention,
                self.files,
                "a tab-indented image",
            ),
            "indented code block",
        )

    def test_uppercase_pre_wrapping_an_image_is_refused(self):
        def rewrite(section):
            out = []
            for line in section:
                if IMAGE_LINE_RE.match(line) and NAMES[1] in line:
                    out += ["<PRE>", line, "</PRE>"]
                else:
                    out.append(line)
            return out

        self.with_readme(self.rewrite_section(rewrite), "'<pre'", "an uppercase PRE")

    def test_tilde_fencing_every_image_is_refused(self):
        def rewrite(section):
            out = []
            for line in section:
                if IMAGE_LINE_RE.match(line):
                    out += ["   ~~~", line, "   ~~~"]
                else:
                    out.append(line)
            return out

        self.with_readme(self.rewrite_section(rewrite), "'~~~'", "tilde-fenced images")

    def test_escaping_an_image_marker_is_refused(self):
        readme = self.readme.replace("![The recovery-phrase", "\\![The recovery-phrase", 1)
        self.with_readme(readme, "'\\\\!'", "an escaped image marker")

    def test_wrapping_an_image_in_pre_is_refused(self):
        def rewrite(section):
            out = []
            for line in section:
                if IMAGE_LINE_RE.match(line) and NAMES[1] in line:
                    out += ["<pre>", line, "</pre>"]
                else:
                    out.append(line)
            return out

        self.with_readme(self.rewrite_section(rewrite), "'<pre'", "a pre-wrapped image")

    def test_an_image_inside_inline_code_is_refused(self):
        readme = self.readme.replace(
            f"![The Pair a new device", f"`![The Pair a new device", 1
        )
        self.with_readme(readme, "'`'", "an inline-coded image")

    def test_turning_an_image_into_a_link_is_refused(self):
        # The `!` is the whole difference between a screenshot and a line of
        # blue text nobody clicks.
        readme = self.readme.replace("![The recovery-phrase", "[The recovery-phrase", 1)
        found = self.refusing(readme, self.convention, self.files, "an image demoted to a link")
        self.kills(found, "does not admit")
        self.kills(found, "in order")

    def test_trailing_whitespace_after_an_image_is_refused(self):
        readme = self.readme.replace(
            f"](docs/captures/{NAMES[0]})\n", f"](docs/captures/{NAMES[0]}) \n", 1
        )
        found = self.refusing(readme, self.convention, self.files, "a trailing space")
        self.kills(found, "does not admit")
        self.kills(found, "in order")

    def test_an_image_naming_an_unknown_capture_is_refused(self):
        readme = self.readme.replace(
            f"](docs/captures/{NAMES[1]})", "](docs/captures/06-extra.png)", 1
        )
        # The anchored name group refuses the LINE, which is a better message
        # than counting a sixth capture and complaining about the order.
        self.kills(
            self.refusing(readme, self.convention, self.files, "an unknown capture name"),
            "does not admit",
        )

    def test_a_png_named_outside_the_convention_table_is_refused_by_nothing(self):
        # The table rule reads the TABLE. A backticked file name in the
        # convention's prose is not a sixth row, and treating it as one would
        # make the rule unable to describe itself.
        convention = self.convention.replace(
            "## How to take them", "A stray `06-stray.png` in prose.\n\n## How to take them", 1
        )
        self.assertEqual([], self.refusing(self.readme, convention, self.files, "prose"))

    def test_an_img_tag_in_the_section_is_refused(self):
        def rewrite(section):
            return section + ['<img src="docs/captures/01-install-from-directory.png">']

        self.with_readme(self.rewrite_section(rewrite), "'<img'", "an img tag")

    def test_empty_alternative_text_is_refused(self):
        readme = re.sub(
            r"!\[[^\]]+\]\(docs/captures/" + re.escape(NAMES[2]) + r"\)",
            f"![](docs/captures/{NAMES[2]})",
            self.readme,
            count=1,
        )
        self.with_readme(readme, "does not admit", "empty alternative text")

    def test_moving_an_image_out_of_the_section_is_refused(self):
        line = next(
            candidate
            for candidate in self.readme.splitlines()
            if IMAGE_LINE_RE.match(candidate) and NAMES[3] in candidate
        )
        readme = self.readme.replace(line + "\n", "", 1).replace(
            "## Get syncing\n", line + "\n\n## Get syncing\n", 1
        )
        self.with_readme(readme, "in order", "an image moved out of the section")

    def test_losing_the_section_heading_is_refused(self):
        readme = self.readme.replace(CAPTURE_SECTION, "## Getting started", 1)
        self.with_readme(readme, "hidden or missing", "a renamed section heading")

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
            self.refusing(self.readme, convention, self.files, "a dropped table row"),
            "docs/captures/README.md",
        )

    def test_losing_the_ceiling_sentence_is_refused(self):
        convention = self.convention.replace(CEILING_SENTENCE, "some megabytes")
        self.kills(
            self.refusing(self.readme, convention, self.files, "a lost ceiling sentence"),
            "no longer states",
        )

    # ---- what is committed ------------------------------------------------

    def test_an_uncommitted_capture_is_refused(self):
        files = {name: blob for name, blob in self.files.items() if name != NAMES[3]}
        found = self.refusing(self.readme, self.convention, files, "a missing capture")
        self.kills(found, "is referenced but not committed")
        self.kills(found, NAMES[3])

    def test_an_unreferenced_capture_is_refused(self):
        files = dict(self.files, **{"06-stray.png": GREY})
        self.kills(
            self.refusing(self.readme, self.convention, files, "a stray capture"),
            "referenced nowhere",
        )

    def test_a_capture_over_the_ceiling_is_refused(self):
        self.with_capture(
            NAMES[0], png_of_at_least(OVER_CEILING), "ceiling", "an oversize capture"
        )

    # ---- framing ----------------------------------------------------------

    def test_a_capture_that_is_not_a_png_is_refused(self):
        self.with_capture(NAMES[1], b"GIF89a" + bytes(64), "PNG signature", "a GIF")

    def test_a_signature_only_capture_is_refused(self):
        self.with_capture(
            NAMES[0], PNG_MAGIC, "signature and nothing else", "a signature-only file"
        )

    def test_a_capture_truncated_after_ihdr_is_refused(self):
        self.with_capture(
            NAMES[2], PNG_MAGIC + ihdr(), "never reaches IEND", "a header-only file"
        )

    def test_a_capture_with_no_iend_is_refused(self):
        blob = PNG_MAGIC + ihdr() + chunk(b"IDAT", zlib.compress(rows()))
        self.with_capture(NAMES[3], blob, "never reaches IEND", "a file with no IEND")

    def test_a_capture_with_no_idat_is_refused(self):
        # Framed correctly -- IHDR first, empty IEND last, nothing after it --
        # and carrying no image at all. Only the IDAT rule can catch this one.
        self.with_capture(
            NAMES[1], assemble(ihdr()), "no IDAT chunk", "a header and a terminator"
        )

    def test_a_capture_with_a_corrupt_crc_is_refused(self):
        broken = bytearray(GREY)
        broken[len(PNG_MAGIC) + CHUNK_OVERHEAD + IHDR_LENGTH - 1] ^= 0xFF
        self.with_capture(NAMES[4], bytes(broken), "fails its CRC-32", "a corrupt CRC")

    def test_a_capture_with_trailing_bytes_is_refused(self):
        self.with_capture(
            NAMES[0], GREY + b"appended", "bytes after IEND", "trailing bytes"
        )

    def test_a_capture_with_an_overlong_chunk_length_is_refused(self):
        broken = bytearray(GREY)
        struct.pack_into(">I", broken, len(PNG_MAGIC), 1 << 30)
        self.with_capture(
            NAMES[1], bytes(broken), "does not fit", "an overlong declared length"
        )

    def test_a_capture_ending_mid_chunk_is_refused(self):
        self.with_capture(NAMES[2], GREY[:-4], "ends mid-chunk", "a mid-chunk end")

    def test_a_capture_with_a_non_letter_chunk_type_is_refused(self):
        broken = bytearray(GREY)
        broken[len(PNG_MAGIC) + 4] = 0x31
        self.with_capture(
            NAMES[3], bytes(broken), "not four letters", "a numeric chunk type"
        )

    def test_a_capture_not_beginning_with_ihdr_is_refused(self):
        blob = assemble(
            chunk(b"pHYs", bytes(9)), ihdr(), chunk(b"IDAT", zlib.compress(rows()))
        )
        self.with_capture(NAMES[4], blob, "rather than IHDR", "pHYs before IHDR")

    # ---- the header -------------------------------------------------------

    def test_a_capture_with_a_short_ihdr_is_refused(self):
        blob = assemble(
            chunk(b"IHDR", struct.pack(">IIBBBB", 1, 1, 8, 0, 0, 0)),
            chunk(b"IDAT", zlib.compress(rows())),
        )
        self.with_capture(NAMES[0], blob, "which must be 13", "a 12-byte IHDR")

    def test_a_capture_with_two_ihdr_chunks_is_refused(self):
        blob = assemble(ihdr(), ihdr(), chunk(b"IDAT", zlib.compress(rows())))
        self.with_capture(NAMES[1], blob, "IHDR chunks, which must be 1", "two IHDRs")

    def test_a_capture_with_zero_dimensions_is_refused(self):
        blob = assemble(ihdr(0, 1), chunk(b"IDAT", zlib.compress(rows())))
        self.with_capture(
            NAMES[2], blob, "implausible dimensions", "a zero-width header"
        )

    def test_a_capture_wider_than_the_bound_is_refused(self):
        self.assertEqual(40000, MAX_DIMENSION)
        blob = assemble(ihdr(40001, 1), chunk(b"IDAT", zlib.compress(rows())))
        self.with_capture(
            NAMES[3], blob, "implausible dimensions", "a 40001-pixel width"
        )

    def test_a_capture_declaring_a_grid_over_budget_is_refused(self):
        self.assertEqual(67108864, MAX_IMAGE_BYTES)
        blob = assemble(
            ihdr(MAX_DIMENSION, MAX_DIMENSION, 8, 6),
            chunk(b"IDAT", zlib.compress(rows())),
        )
        self.with_capture(NAMES[4], blob, "budget this suite will inflate", "a huge grid")

    def test_a_capture_with_an_unknown_colour_type_is_refused(self):
        blob = assemble(ihdr(1, 1, 8, 7), chunk(b"IDAT", zlib.compress(rows())))
        self.with_capture(NAMES[0], blob, "colour type 7", "colour type 7")

    def test_a_capture_with_an_illegal_bit_depth_is_refused(self):
        blob = assemble(ihdr(1, 1, 3, 0), chunk(b"IDAT", zlib.compress(rows())))
        self.with_capture(NAMES[1], blob, "bit depth 3", "bit depth 3")

    def test_each_colour_type_refuses_a_depth_only_another_type_allows(self):
        # One fixture per colour type, each carrying a bit depth that is legal
        # for SOME type and not for this one. Widening any single row of
        # COLOUR_FORMS turns exactly one of these from a refusal into a pass.
        cases = {
            2: (2, 2, 4),
            3: (4, 2, 16),
            4: (2, 2, 2),
            6: (3, 3, 1),
        }
        for colour, (width, height, depth) in cases.items():
            with self.subTest(colour=colour, depth=depth):
                parts = [ihdr(width, height, depth, colour)]
                if colour == 3:
                    parts.append(chunk(b"PLTE", bytes(12)))
                # rows() is computed for a depth this type DOES allow, because
                # the header is refused before the grid is ever inflated.
                parts.append(chunk(b"IDAT", zlib.compress(rows(width, height, 8, colour))))
                self.with_capture(
                    NAMES[0], assemble(*parts), f"bit depth {depth}", f"type {colour} at {depth} bits"
                )

    def test_a_capture_declaring_another_compression_method_is_refused(self):
        blob = assemble(
            ihdr(compression=1), chunk(b"IDAT", zlib.compress(rows()))
        )
        self.with_capture(
            NAMES[2], blob, "compression method 1", "compression method 1"
        )

    def test_a_capture_declaring_another_filter_method_is_refused(self):
        blob = assemble(ihdr(filtering=1), chunk(b"IDAT", zlib.compress(rows())))
        self.with_capture(NAMES[3], blob, "filter method 1", "filter method 1")

    def test_an_interlaced_capture_is_refused(self):
        blob = assemble(ihdr(interlace=1), chunk(b"IDAT", zlib.compress(rows())))
        self.with_capture(NAMES[4], blob, "interlace method 1", "an Adam7 image")

    # ---- palette and chunk order ------------------------------------------

    def test_an_indexed_capture_without_a_palette_is_refused(self):
        blob = assemble(
            ihdr(4, 2, 2, 3), chunk(b"IDAT", zlib.compress(rows(4, 2, 2, 3)))
        )
        self.with_capture(NAMES[0], blob, "no PLTE chunk", "indexed with no palette")

    def test_a_palette_after_the_first_idat_is_refused(self):
        blob = assemble(
            ihdr(4, 2, 2, 3),
            chunk(b"IDAT", zlib.compress(rows(4, 2, 2, 3))),
            chunk(b"PLTE", bytes(12)),
        )
        self.with_capture(NAMES[1], blob, "before its first IDAT", "a late palette")

    def test_a_truecolour_palette_of_the_wrong_length_is_refused(self):
        blob = assemble(
            ihdr(2, 2, 8, 2),
            chunk(b"PLTE", bytes(10)),
            chunk(b"IDAT", zlib.compress(rows(2, 2, 8, 2))),
        )
        self.with_capture(NAMES[2], blob, "three-byte entries", "a 10-byte palette")

    def test_two_palettes_are_refused(self):
        blob = assemble(
            ihdr(4, 2, 2, 3),
            chunk(b"PLTE", bytes(12)),
            chunk(b"PLTE", bytes(12)),
            chunk(b"IDAT", zlib.compress(rows(4, 2, 2, 3))),
        )
        self.with_capture(NAMES[0], blob, "PLTE chunks, which must be at most 1", "two palettes")

    def test_more_palette_entries_than_the_depth_can_name_is_refused(self):
        # Three entries behind one-bit indices: the third can never be chosen,
        # which means this file does not say what it appears to say.
        blob = assemble(
            ihdr(8, 2, 1, 3),
            chunk(b"PLTE", bytes(9)),
            chunk(b"IDAT", zlib.compress(rows(8, 2, 1, 3))),
        )
        self.with_capture(
            NAMES[1], blob, "palette entries, more than the", "three entries at one bit"
        )

    def test_a_palette_over_the_byte_bound_is_refused(self):
        self.assertEqual(768, MAX_PALETTE_BYTES)
        blob = assemble(
            ihdr(2, 2, 8, 2),
            chunk(b"PLTE", bytes(771)),
            chunk(b"IDAT", zlib.compress(rows(2, 2, 8, 2))),
        )
        self.with_capture(
            NAMES[2], blob, "three-byte entries", "a 257-entry palette"
        )

    def test_a_greyscale_palette_is_refused(self):
        blob = assemble(
            ihdr(), chunk(b"PLTE", bytes(3)), chunk(b"IDAT", zlib.compress(rows()))
        )
        self.with_capture(
            NAMES[3], blob, "PLTE chunk with greyscale", "a greyscale palette"
        )

    def test_non_consecutive_idat_chunks_are_refused(self):
        split = zlib.compress(rows(8, 8, 8, 6))
        blob = assemble(
            ihdr(8, 8, 8, 6),
            chunk(b"IDAT", split[: len(split) // 2]),
            chunk(b"tEXt", b"gap\x00"),
            chunk(b"IDAT", split[len(split) // 2 :]),
        )
        self.with_capture(
            NAMES[4], blob, "between its IDAT chunks", "a gap between IDATs"
        )

    def test_a_nonempty_iend_is_refused(self):
        blob = assemble(
            ihdr(), chunk(b"IDAT", zlib.compress(rows())), iend=b"tail"
        )
        self.with_capture(NAMES[0], blob, "IEND, which must be empty", "a nonempty IEND")

    # ---- the image data ---------------------------------------------------

    def test_an_empty_idat_is_refused(self):
        blob = assemble(ihdr(), chunk(b"IDAT", b""))
        self.assertEqual(57, len(blob))
        self.with_capture(NAMES[1], blob, "never terminates", "an empty IDAT")

    def test_idat_that_is_not_deflate_is_refused(self):
        blob = assemble(ihdr(), chunk(b"IDAT", b"not-deflate"))
        self.with_capture(
            NAMES[2], blob, "not a valid deflate stream", "non-deflate IDAT bytes"
        )

    def test_a_deflate_stream_one_byte_short_is_refused(self):
        blob = assemble(ihdr(), chunk(b"IDAT", zlib.compress(rows())[:-1]))
        self.with_capture(NAMES[3], blob, "never terminates", "a truncated deflate stream")

    def test_a_deflate_stream_with_one_extra_row_is_refused(self):
        blob = assemble(ihdr(1, 1), chunk(b"IDAT", zlib.compress(rows(1, 2))))
        self.with_capture(NAMES[4], blob, "inflates", "one row too many")

    def test_a_grid_one_row_short_is_refused(self):
        blob = assemble(ihdr(1, 2), chunk(b"IDAT", zlib.compress(rows(1, 1))))
        self.with_capture(NAMES[0], blob, "inflates to", "one row too few")

    def test_an_illegal_filter_byte_is_refused(self):
        blob = assemble(
            ihdr(), chunk(b"IDAT", zlib.compress(rows(filter_byte=5)))
        )
        self.with_capture(NAMES[1], blob, "filter byte 5", "filter byte 5")

    def test_bytes_after_the_deflate_stream_are_refused(self):
        blob = assemble(ihdr(), chunk(b"IDAT", zlib.compress(rows()) + b"extra"))
        self.with_capture(
            NAMES[2], blob, "after the IDAT deflate stream", "bytes after the stream"
        )


if __name__ == "__main__":
    unittest.main()
