"""Translations follow the English text; the links and the commands prove it.

WHY. `docs/translations.md` says the English README and Cloudflare guide are
canonical and that twenty translations under `docs/<code>/` follow them. A
sentence like that is a promise nothing enforces: a command edited in the
English page and not in a translation is a stranger pasting a stale command in
their own language, and a link that resolves in English and not in a
translation is a 404 a reviewer never clicks. So the shape is held here.

WHAT IS ESTABLISHED, exactly and only:

  1. THE LANGUAGE SET. The README's language line names every language in
     `LANGUAGES`, in that order, each linking to `docs/<code>/README.md`; the
     directories that exist under `docs/` with a translated README are exactly
     those codes; and `docs/translations.md` lists the same codes.
  2. THE CANONICAL LINE. Each translated file's first non-empty line links back
     to the English page it mirrors, so a reader of the translation can find
     the text it follows.
  3. BYTE-EQUAL COMMANDS. Every fenced block in a translation equals, byte for
     byte and in the same order, the fenced blocks of its English page: the
     fence's info string and the body. Prose is translated; commands are not.
  4. LINKS RESOLVE. Every relative link and image in README.md and under
     `docs/` points at a file that exists, and a `#fragment` on a Markdown
     target names a heading that page carries. Absolute URLs are not fetched.

It establishes nothing about the QUALITY of a translation: whether the prose
is idiomatic, or whether an Obsidian menu name matches Obsidian's own
localisation, is a reviewer's reading, recorded in the pull request.

EVERY RULE HAS A NEGATIVE TEST, run over in-memory fixtures, never over the
repository. Standard library only (requirement 5).
"""

from __future__ import annotations

import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
README = ROOT / "README.md"
DOCS = ROOT / "docs"
TRANSLATIONS_PAGE = DOCS / "translations.md"

# The language set, in the order the README's language line carries it. Codes
# are directory names under docs/; names are the endonyms the line shows.
LANGUAGES: tuple[tuple[str, str], ...] = (
    ("ar", "العربية"),
    ("de", "Deutsch"),
    ("es", "Español"),
    ("fa", "فارسی"),
    ("fr", "Français"),
    ("id", "Bahasa Indonesia"),
    ("it", "Italiano"),
    ("nl", "Nederlands"),
    ("pl", "Polski"),
    ("pt", "Português"),
    ("pt-br", "Português (Brasil)"),
    ("ru", "Русский"),
    ("th", "ไทย"),
    ("tr", "Türkçe"),
    ("uk", "Українська"),
    ("vi", "Tiếng Việt"),
    ("ja", "日本語"),
    ("ko", "한국어"),
    ("zh-cn", "中文简体"),
    ("zh-tw", "中文繁體"),
)
# The pages that are translated, as (English path, name inside docs/<code>/).
MIRRORED: tuple[tuple[Path, str], ...] = (
    (README, "README.md"),
    (DOCS / "cloudflare.md", "cloudflare.md"),
)
LANGUAGE_LINE_PREFIX = "Read in your language: "
LANGUAGE_LINK = re.compile(r"\[(?P<name>[^\]]+)\]\((?P<target>[^)\s]+)\)")
FENCE = re.compile(r"^(?P<indent> {0,3})(?P<fence>`{3,}|~{3,})(?P<info>[^`]*)$")
# A Markdown link or image whose target is written inline. Reference-style
# links are not used in this repository's documentation.
INLINE_LINK = re.compile(r"!?\[[^\]]*\]\((?P<target>[^)\s]+)(?:\s+\"[^\"]*\")?\)")
HEADING = re.compile(r"^#{1,6}\s+(?P<text>.+?)\s*#*\s*$")
SCHEME = re.compile(r"^[a-z][a-z0-9+.-]*:", re.IGNORECASE)


def fenced_blocks(text: str) -> list[tuple[str, str]]:
    """Every fenced block as (info string, body), in document order.

    CommonMark 4.5: the opener is up to three spaces then three or more
    backticks or tildes; the closer is a run of the same character at least as
    long. Bodies are compared with the opener's indentation removed from each
    line, which is what a reader copies.
    """
    found: list[tuple[str, str]] = []
    lines = text.splitlines()
    index = 0
    while index < len(lines):
        opener = FENCE.match(lines[index])
        if opener is None:
            index += 1
            continue
        fence = opener.group("fence")
        indent = len(opener.group("indent"))
        body: list[str] = []
        cursor = index + 1
        while cursor < len(lines):
            line = lines[cursor]
            stripped = line.lstrip(" ")
            if (
                len(line) - len(stripped) <= 3
                and stripped.startswith(fence[0] * len(fence))
                and stripped.strip(fence[0]) == ""
            ):
                break
            body.append(line[indent:] if line[:indent].strip() == "" else line)
            cursor += 1
        found.append((opener.group("info").strip(), "\n".join(body)))
        index = cursor + 1
    return found


def slug(heading: str) -> str:
    """GitHub's heading anchor: lowercase, punctuation dropped, spaces to hyphens.

    Inline code and emphasis markers are removed first, so `## Run \\`x\\``
    and `## Run x` produce the same anchor a renderer does.
    """
    text = re.sub(r"[`*]", "", heading).strip().lower()
    text = re.sub(r"[^\w\- ]", "", text)
    return text.replace(" ", "-")


def anchors(text: str) -> set[str]:
    found: set[str] = set()
    outside = _outside_fences(text)
    for line in outside.splitlines():
        heading = HEADING.match(line)
        if heading:
            found.add(slug(heading.group("text")))
    return found


def _outside_fences(text: str) -> str:
    """The document with every fenced block's body blanked, so a `#` or a
    `[x](y)` inside a command is not read as a heading or a link."""
    kept: list[str] = []
    inside: str | None = None
    for line in text.splitlines():
        opener = FENCE.match(line)
        if inside is None and opener is not None:
            inside = opener.group("fence")
            kept.append("")
            continue
        if inside is not None:
            stripped = line.lstrip(" ")
            if stripped.startswith(inside[0] * len(inside)) and stripped.strip(inside[0]) == "":
                inside = None
            kept.append("")
            continue
        kept.append(line)
    return "\n".join(kept)


def relative_targets(text: str) -> list[str]:
    """Every inline link or image target that is not an absolute URL."""
    found: list[str] = []
    for match in INLINE_LINK.finditer(_outside_fences(text)):
        target = match.group("target")
        if SCHEME.match(target) or "<" in target:
            # An absolute URL is not fetched; a `<placeholder>` in a convention
            # page is a description of a link, not a link.
            continue
        found.append(target)
    return found


def unresolved(page: Path, text: str, files: dict[Path, str]) -> list[str]:
    """Rule 4 over one page, against a mapping of path -> text for Markdown."""
    found: list[str] = []
    for target in relative_targets(text):
        path_part, _, fragment = target.partition("#")
        if path_part == "":
            resolved = page
        else:
            resolved = (page.parent / path_part).resolve()
            if not resolved.exists() and resolved not in files:
                found.append(f"{page.relative_to(ROOT)}: {target!r} does not exist")
                continue
        if fragment and resolved.suffix == ".md":
            body = files.get(resolved)
            if body is None and resolved.exists():
                body = resolved.read_text(encoding="utf-8")
            if body is None or fragment.lower() not in anchors(body):
                found.append(
                    f"{page.relative_to(ROOT)}: {target!r} names a heading "
                    f"{resolved.relative_to(ROOT)} does not carry"
                )
    return found


def language_line(readme: str) -> str | None:
    for line in readme.splitlines():
        if line.startswith(LANGUAGE_LINE_PREFIX):
            return line
    return None


def language_line_refusals(readme: str) -> list[str]:
    """Rule 1, the README half: the line exists and names the set in order."""
    line = language_line(readme)
    if line is None:
        return [f"README.md carries no line starting {LANGUAGE_LINE_PREFIX!r}"]
    links = [(m.group("name"), m.group("target")) for m in LANGUAGE_LINK.finditer(line)]
    expected = [("English", "README.md")] + [
        (name, f"docs/{code}/README.md") for code, name in LANGUAGES
    ]
    if links != expected:
        return [
            "README.md: the language line names "
            f"{[t for _, t in links]}, not {[t for _, t in expected]} "
            "(names and targets, in LANGUAGES order)"
        ]
    return []


def translation_directories() -> list[str]:
    """A directory under docs/ that carries every mirrored page is a translation.

    docs/captures/ and docs/validation-runs/ carry a README.md of their own and
    no cloudflare.md, so they are not counted."""
    names = [name for _, name in MIRRORED]
    return sorted(
        path.name
        for path in DOCS.iterdir()
        if path.is_dir() and any((path / name).exists() for name in names)
        and all((path / name).exists() for name in names)
    )


def canonical_refusals(code: str, name: str, text: str) -> list[str]:
    """Rule 2: the first non-empty line links back to the English page."""
    first = next((line for line in text.splitlines() if line.strip()), "")
    back = "../../README.md" if name == "README.md" else f"../{name}"
    if f"]({back})" not in first:
        return [f"docs/{code}/{name}: the first line does not link back to {back}"]
    return []


def fence_refusals(code: str, name: str, english: str, translated: str) -> list[str]:
    """Rule 3: the fenced blocks are the English ones, byte for byte, in order."""
    mine = fenced_blocks(translated)
    theirs = fenced_blocks(english)
    if len(mine) != len(theirs):
        return [
            f"docs/{code}/{name}: {len(mine)} fenced blocks, the English page has "
            f"{len(theirs)}"
        ]
    found: list[str] = []
    for position, (ours, original) in enumerate(zip(mine, theirs), start=1):
        if ours != original:
            found.append(
                f"docs/{code}/{name}: fenced block {position} differs from the "
                f"English page (info {ours[0]!r} vs {original[0]!r})"
            )
    return found


class TheTranslationsFollowTheEnglishText(unittest.TestCase):
    """The real files, as committed."""

    def test_the_language_line_names_every_translation_in_order(self):
        self.assertEqual(language_line_refusals(README.read_text(encoding="utf-8")), [])

    def test_the_directories_are_exactly_the_language_set(self):
        self.assertEqual(translation_directories(), sorted(code for code, _ in LANGUAGES))

    def test_the_translations_page_lists_the_same_codes(self):
        page = TRANSLATIONS_PAGE.read_text(encoding="utf-8")
        for code, name in LANGUAGES:
            self.assertIn(f"| `{code}` | {name} |", page, code)

    def test_every_translation_carries_the_canonical_line(self):
        found: list[str] = []
        for code, _ in LANGUAGES:
            for _, name in MIRRORED:
                path = DOCS / code / name
                self.assertTrue(path.exists(), f"{path.relative_to(ROOT)} is missing")
                found.extend(canonical_refusals(code, name, path.read_text(encoding="utf-8")))
        self.assertEqual(found, [])

    def test_every_fenced_block_equals_the_english_one(self):
        found: list[str] = []
        for code, _ in LANGUAGES:
            for english, name in MIRRORED:
                found.extend(
                    fence_refusals(
                        code,
                        name,
                        english.read_text(encoding="utf-8"),
                        (DOCS / code / name).read_text(encoding="utf-8"),
                    )
                )
        self.assertEqual(found, [])

    def test_the_english_pages_carry_commands_to_compare(self):
        # Non-vacuity for the rule above: a README with no fenced block would
        # make byte-equality true of every translation, including an empty one.
        # The short README carries three: cosign verify, the compose command,
        # the token read.
        self.assertGreaterEqual(len(fenced_blocks(README.read_text(encoding="utf-8"))), 3)

    def test_every_relative_link_under_docs_and_in_the_readme_resolves(self):
        pages = [README, *sorted(DOCS.rglob("*.md"))]
        files = {page: page.read_text(encoding="utf-8") for page in pages}
        found: list[str] = []
        for page, text in files.items():
            found.extend(unresolved(page, text, files))
        self.assertEqual(found, [])

    def test_the_link_walk_reads_the_translations(self):
        pages = list(DOCS.rglob("*.md"))
        self.assertGreaterEqual(
            len([p for p in pages if p.parent != DOCS and p.parent.parent == DOCS]),
            2 * len(LANGUAGES),
        )


class MutatedFixturesAreRefused(unittest.TestCase):
    """One broken property per test, in memory, never on disk."""

    ENGLISH = "# Page\n\nText.\n\n```sh\ncosign verify x\n```\n\nMore.\n\n```text\na: b\n```\n"
    GOOD = (
        "Translation of [the English page](../../README.md).\n\n# Seite\n\nText.\n\n"
        "```sh\ncosign verify x\n```\n\nMehr.\n\n```text\na: b\n```\n"
    )

    def test_the_fixture_baseline_is_clean(self):
        self.assertEqual(fence_refusals("de", "README.md", self.ENGLISH, self.GOOD), [])
        self.assertEqual(canonical_refusals("de", "README.md", self.GOOD), [])

    def test_a_translated_command_is_refused(self):
        mutated = self.GOOD.replace("cosign verify x", "cosign verifizieren x")
        found = fence_refusals("de", "README.md", self.ENGLISH, mutated)
        self.assertTrue(any("fenced block 1 differs" in f for f in found), found)

    def test_a_dropped_block_is_refused(self):
        mutated = self.GOOD.replace("```text\na: b\n```\n", "")
        found = fence_refusals("de", "README.md", self.ENGLISH, mutated)
        self.assertTrue(any("1 fenced blocks" in f for f in found), found)

    def test_a_reordered_block_is_refused(self):
        mutated = self.GOOD.replace("```sh\ncosign verify x\n```", "```text\na: b\n```", 1)
        found = fence_refusals("de", "README.md", self.ENGLISH, mutated)
        self.assertNotEqual(found, [])

    def test_a_changed_info_string_is_refused(self):
        mutated = self.GOOD.replace("```sh\n", "```bash\n", 1)
        found = fence_refusals("de", "README.md", self.ENGLISH, mutated)
        self.assertTrue(any("info 'bash' vs 'sh'" in f for f in found), found)

    def test_a_missing_canonical_line_is_refused(self):
        mutated = self.GOOD.replace("Translation of [the English page](../../README.md).\n\n", "")
        self.assertNotEqual(canonical_refusals("de", "README.md", mutated), [])

    def test_a_language_line_out_of_order_is_refused(self):
        line = LANGUAGE_LINE_PREFIX + " • ".join(
            [f"[English](README.md)"] + [f"[{n}](docs/{c}/README.md)" for c, n in LANGUAGES]
        )
        self.assertEqual(language_line_refusals(line + "\n"), [])
        swapped = line.replace("[Deutsch](docs/de/README.md)", "[Deutsch](docs/es/README.md)", 1)
        self.assertNotEqual(language_line_refusals(swapped + "\n"), [])
        self.assertNotEqual(language_line_refusals("# No line\n"), [])

    def test_a_dangling_link_and_a_dangling_anchor_are_refused(self):
        page = DOCS / "zz-fixture" / "README.md"
        text = "[gone](../missing.md) and [there](../translations.md#no-such-heading)\n"
        found = unresolved(page, text, {page: text})
        self.assertEqual(len(found), 2, found)

    def test_a_link_inside_a_fence_is_not_judged(self):
        page = DOCS / "zz-fixture" / "README.md"
        text = "```sh\ncurl [x](../missing.md)\n```\n"
        self.assertEqual(unresolved(page, text, {page: text}), [])

    def test_the_slug_matches_what_a_renderer_produces(self):
        self.assertEqual(slug("Trust the certificate authority, once per device"),
                         "trust-the-certificate-authority-once-per-device")
        self.assertEqual(slug("`edge_required`"), "edge_required")
        self.assertEqual(slug("Shape A: a private route"), "shape-a-a-private-route")


if __name__ == "__main__":
    unittest.main()
