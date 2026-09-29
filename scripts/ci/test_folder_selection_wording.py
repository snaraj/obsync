"""A folder selection can be widened, and no page or screen may say otherwise.

WHY. Three help pages told people that once a device had synced, its folder
selection "can only NARROW" and "Expansion of a used device's selection is
refused" (#171). Widening works: saving a wider selection replays the history
this device skipped (`saveSyncFolders` in `plugin/src/main.ts`), so readers
built workarounds for a restriction that did not exist. The pages were
corrected; this keeps them corrected.

WHAT IS ESTABLISHED, exactly and only: no text in README.md, in any Markdown
under docs/, or in plugin/src says a selection may only narrow or that
widening or expanding it is refused. Case and Markdown emphasis are folded
first, and a phrase split across lines still matches. CHANGELOG.md is not read:
it records what earlier releases did, and those entries were true when written.
Whether a page describes widening WELL is a reader's review, not this test.
"""

from __future__ import annotations

import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]

FALSE_CLAIMS = (
    re.compile(r"\b(?:can|may|must|will)\s+only\s+(?:be\s+)?narrow"),
    re.compile(r"\bexpan(?:sion|ds?|ded|ding)\b[^.;]{0,80}?\brefused\b"),
    re.compile(r"\bwiden(?:s|ed|ing)?\b[^.;]{0,80}?\b(?:is|are|was|were)\s+refused\b"),
)


def false_claims(text: str) -> list[str]:
    prose = re.sub(r"[*_`]", "", text).lower()
    return [match.group(0) for pattern in FALSE_CLAIMS for match in pattern.finditer(prose)]


def sources() -> list[Path]:
    return [
        ROOT / "README.md",
        *sorted((ROOT / "docs").rglob("*.md")),
        *sorted((ROOT / "plugin" / "src").rglob("*.ts")),
    ]


class NoPageSaysASelectionOnlyNarrows(unittest.TestCase):
    def test_the_sentences_that_shipped_are_refused(self):
        for shipped in (
            "The selection can only NARROW once a device has synced.",
            "Expansion of a used device's selection is refused;",
            "Select the final folders now: after sync has history, the selection may\n   only narrow.",
            "its notes then sync, or the plugin states in the UI why an expanded selection is refused.",
            "Widening a used device's selection is refused.",
            "The selection can only **narrow** once a device has synced.",
        ):
            with self.subTest(shipped=shipped):
                self.assertNotEqual(false_claims(shipped), [])

    def test_the_true_sentences_pass(self):
        for true in (
            "You can narrow or widen the selection after pairing. Widening replays retained history.",
            "Narrowing keeps excluded local files and server history.",
            "Another device cannot change this device's selection.",
            "Choose folders before pairing; other devices cannot widen this.",
            "The window is a constant, and nothing in the plugin can widen it.",
            "Saving the wider selection downloads existing server history for those folders.",
        ):
            with self.subTest(true=true):
                self.assertEqual(false_claims(true), [])

    def test_no_page_or_screen_says_a_selection_only_narrows(self):
        read = {path.relative_to(ROOT).as_posix() for path in sources()}
        # The subject: the pages that carried the claim, and the screen that
        # shows the selection, are among what this test reads.
        self.assertLessEqual(
            {
                "docs/daily-use.md",
                "docs/quickstart.md",
                "docs/settings.md",
                "docs/validation.md",
                "plugin/src/ui/settings.ts",
            },
            read,
        )
        for path in sources():
            with self.subTest(path=path.relative_to(ROOT).as_posix()):
                self.assertEqual(false_claims(path.read_text(encoding="utf-8")), [])


if __name__ == "__main__":
    unittest.main()
