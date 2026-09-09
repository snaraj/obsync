"""Offline coverage for `codeql_dispositions.py`, the file it reads, and its wiring.

The standard for this range: the disposition file is the only way an alert in
this repository ever goes quiet again, so every refusal that keeps it honest
must have a test that fails when the refusal is deleted, and the workflow that
makes those refusals effective must be pinned by what it RUNS, not by what it
mentions.

Part one is the schema, one refusal at a time: an unknown key, a wildcard rule
id, a glob that names no place, an over-long or multi-line comment, a reason
CodeQL does not accept, a disposition in another repository, two scopes at
once, `within: test-module` over a file with no Rust in it, and `used in tests`
over product code -- the entry that would let a real finding be filed under a
reason that is not true.

Part two is matching, on a synthetic tree: `*` stays inside one segment and
`**` crosses them, `line_contains` reads the line CodeQL actually flagged, and
`within: test-module` accepts a line at or after the `#[cfg(test)]` marker and
refuses one above it.

Part three is the three commands: `check` names an uncovered alert and exits 1,
reports an entry that matched nothing, and refuses a listing whose alerts were
analysed on another ref or are not open; `plan` emits exactly the covered
alerts, only from main, with a composed comment that fits.

Part four pins the SHIPPED file against the SHIPPED tree: every entry validates
against `git ls-files`, and the three alert classes the repository has actually
seen are covered by the entry that claims them.

Part five reads `.github/workflows/codeql.yml` through the repository's
fail-closed YAML reader and pins the narrow wiring that makes the decision
effective: the job, its dependency, its exact permissions, the dismiss step's
push guard, the absence of a guard on the check step, the order that puts the
indexing wait before the listing, and the absence of any construct that would
exclude code from analysis.

Part six EXECUTES the production `run:` blocks verbatim under bash with `gh`
and `sleep` stand-ins on PATH and the real `jq`, `git` and `python3`: an
analysis still processing is waited for, one that failed is refused, an
uncovered alert fails the step, a push dismisses exactly the covered alerts and
then requires main to hold none, and nothing a pull request runs writes
anything. Text pins cannot see a `|| true`; an executed step can.
"""

from __future__ import annotations

import contextlib
import hashlib
import io
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import codeql_dispositions as cd  # noqa: E402
import miniyaml  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
WORKFLOW = ROOT / ".github" / "workflows" / "codeql.yml"
DISPOSITIONS = ROOT / "security" / "codeql-dispositions.json"

CRYPTO_RULE = "rust/hard-coded-cryptographic-value"
LOGGING_RULE = "rust/cleartext-logging"
URL_RULE = "js/incomplete-url-substring-sanitization"
ISSUE = "https://github.com/snaraj/obsync/issues/22"
PR_REF = "refs/pull/23/merge"

TRACKED = [
    "README.md",
    "crates/obsync-core/src/hkdf.rs",
    "crates/obsyncd/src/api/auth.rs",
    "crates/obsyncd/src/api/server_test.rs",
    "crates/obsyncd/src/storage/mod.rs",
    "crates/obsyncd/src/storage/tests.rs",
    "dashboard/test/lib.test.mjs",
    "plugin/src/main.ts",
    "plugin/test/bundle.test.mjs",
    "plugin/test/fixtures/generate.mjs",
    "scripts/ci/test_codeql_dispositions.py",
]

_ABSENT = object()

COMMIT = "f" * 40
ANALYSIS_KEY = ".github/workflows/codeql.yml:analyze"
# The shape main was really in on 2026-09-09 (push run 34368935826 at
# f229a46): 33 of 78 dismissals stamped `fixed_at` with their instance left on
# the previous commit, e4aa059, and the other 45 unstamped on the judged one.
PREVIOUS_COMMIT = "e4aa059c671b872d3761440141ab841a7e89be50"
FIXED_AT = "2026-09-09T15:17:32Z"
# What a pull request judges the base's alerts at: the commit the base's two
# analyses agree on, never this pull request's own head.
BASE_ANALYSES_COMMIT = "9" * 40
SALT_LINE = 'const WRAP_SALT: &[u8] = b"obsync/v1/wrap";'
# A hash whose shape is right and whose value is nobody's file: entries that
# only need to satisfy the product-code rule carry it, and every test that
# actually verifies content computes the real digest instead.
UNREAD_SHA256 = "a" * 64


def entry(**overrides: object) -> dict:
    """One well-formed entry, with `_ABSENT` removing a field.

    The default names PRODUCT code, so it carries `line_is`: an acceptance over
    shipped code has to say what was read. A caller using another location
    predicate drops it explicitly with `line_is=_ABSENT`.
    """
    record: dict[str, object] = {
        "rule": CRYPTO_RULE,
        "path": "crates/obsyncd/src/storage/mod.rs",
        "line_is": SALT_LINE,
        "reason": "false positive",
        "comment": "a domain separator, not a secret",
        "disposition": ISSUE,
    }
    record.update(overrides)
    return {key: value for key, value in record.items() if value is not _ABSENT}


def alert(
    number: int = 1,
    rule: str = CRYPTO_RULE,
    path: str = "crates/obsyncd/src/storage/mod.rs",
    line: int = 1,
    ref: str = cd.MAIN_REF,
    state: str = "open",
    commit: str = COMMIT,
    key: str = ANALYSIS_KEY,
    fixed_at: str | None = None,
    dismissed_reason: str | None = None,
    dismissed_comment: str | None = None,
) -> dict:
    return {
        "number": number,
        "state": state,
        "rule": {"id": rule, "severity": "warning"},
        "fixed_at": fixed_at,
        "dismissed_reason": dismissed_reason,
        "dismissed_comment": dismissed_comment,
        "most_recent_instance": {
            "ref": ref,
            "commit_sha": commit,
            "analysis_key": key,
            "location": {"path": path, "start_line": line, "end_line": line},
        },
    }


def dismissed(number: int, entry_record: dict, **overrides: object) -> dict:
    """A dismissed alert whose stored justification is the entry's, unless told otherwise."""
    stored = {
        "dismissed_reason": entry_record["reason"],
        "dismissed_comment": f"{entry_record['comment']}"
        f"{cd.DISPOSITION_JOIN}{entry_record['disposition']}",
    }
    stored.update(overrides)
    return alert(number=number, state="dismissed", **stored)


def load(document: list[dict], ref: str = cd.MAIN_REF, states: tuple[str, ...] = ("open",)):
    return cd.load_alerts(document, ref, COMMIT, ANALYSIS_KEY, states)


def run_cli(argv: list[str]) -> tuple[int, str, str]:
    out, err = io.StringIO(), io.StringIO()
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
        code = cd.main(argv)
    return code, out.getvalue(), err.getvalue()


class SchemaRefusals(unittest.TestCase):
    """Each closed-parsing refusal, one at a time, naming the field."""

    def refuse(self, raw: dict, expected: str, tracked: list[str] | None = None) -> None:
        with self.assertRaises(cd.Refusal) as caught:
            cd.load_entries([raw], TRACKED if tracked is None else tracked)
        self.assertIn(expected, str(caught.exception))

    def test_the_reference_entry_is_accepted(self):
        loaded = cd.load_entries([entry()], TRACKED)
        self.assertEqual(len(loaded), 1)
        self.assertEqual(loaded[0].index, 0)
        self.assertEqual(loaded[0].matches, 1)

    def test_an_unknown_key_is_refused(self):
        self.refuse(entry(severity="warning"), "unknown field(s): severity")

    def test_a_missing_field_is_refused(self):
        for field in cd.REQUIRED_FIELDS:
            with self.subTest(field=field):
                self.refuse(entry(**{field: _ABSENT}), f"missing field {field}")

    def test_a_non_string_field_is_refused(self):
        self.refuse(entry(comment=7), "field comment is not a string")

    def test_a_non_object_entry_is_refused(self):
        self.refuse(["rule"], "entry 0 is not an object")

    def test_a_wildcard_rule_is_refused(self):
        for rule in ("rust/*", "*", "rust/hard-coded-*", "Rust/x", "rust/x/y"):
            with self.subTest(rule=rule):
                self.refuse(entry(rule=rule), "not one exact CodeQL rule id")

    def test_a_glob_that_names_no_place_is_refused(self):
        for path in ("**", "**/*", "*/*.rs", "*"):
            with self.subTest(path=path):
                self.refuse(entry(path=path), "has no literal segment")

    def test_an_unreadable_or_absolute_glob_is_refused(self):
        for path, expected in (
            ("/crates/x.rs", "not a relative path glob"),
            ("crates/", "not a relative path glob"),
            ("crates//x.rs", "empty or relative segment"),
            ("crates/../x.rs", "empty or relative segment"),
            ("crates/x?.rs", "unmodelled character"),
            ("crates/a**b/x.rs", "uses `**` inside a segment"),
        ):
            with self.subTest(path=path):
                self.refuse(entry(path=path), expected)

    def test_a_glob_matching_no_tracked_file_is_refused(self):
        self.refuse(entry(path="crates/obsyncd/src/absent.rs"), "matches no tracked file")

    def test_a_comment_longer_than_280_characters_is_refused(self):
        self.refuse(entry(comment="x" * 281), "field comment is longer than 280")

    def test_a_composed_comment_longer_than_280_characters_is_refused(self):
        # The comment alone fits; the dismissal carries the disposition too,
        # and GitHub would truncate the pair.
        comment = "x" * 240
        self.assertLessEqual(len(comment), cd.COMMENT_MAX)
        self.assertGreater(len(comment + cd.DISPOSITION_JOIN + ISSUE), cd.COMMENT_MAX)
        self.refuse(entry(comment=comment), "composed dismissal comment is 296 characters")

    def test_the_longest_comment_that_still_fits_is_accepted(self):
        comment = "x" * (cd.COMMENT_MAX - len(cd.DISPOSITION_JOIN + ISSUE))
        loaded = cd.load_entries([entry(comment=comment)], TRACKED)
        self.assertEqual(len(loaded[0].dismissal_comment), cd.COMMENT_MAX)

    def test_a_multi_line_or_untrimmed_comment_is_refused(self):
        for comment in ("first\nsecond", "trailing\n", "carriage\rreturn", " padded "):
            with self.subTest(comment=comment):
                self.refuse(entry(comment=comment), "not a single trimmed line")

    def test_an_empty_comment_is_refused(self):
        self.refuse(entry(comment=""), "field comment is empty")

    def test_a_reason_outside_codeqls_three_is_refused(self):
        for reason in ("wontfix", "false-positive", "accepted", "used in test", ""):
            with self.subTest(reason=reason):
                self.refuse(entry(reason=reason), "field reason must be one of")

    def test_a_disposition_outside_this_repository_is_refused(self):
        for disposition in (
            "https://github.com/snaraj/naranjo/issues/22",
            "https://github.com/other/obsync/issues/22",
            "http://github.com/snaraj/obsync/issues/22",
            "https://github.com/snaraj/obsync/pull/22",
            "https://github.com/snaraj/obsync/issues/0",
            "https://github.com/snaraj/obsync/issues/22#comment",
        ):
            with self.subTest(disposition=disposition):
                self.refuse(entry(disposition=disposition), "not an issue in this repository")

    def test_two_scopes_at_once_are_refused(self):
        self.refuse(
            entry(path="crates/**/*.rs", line_is=_ABSENT, line_contains="WRAP_SALT", within="test-module"),
            "carries line_contains and within",
        )

    def test_a_short_or_untrimmed_line_token_is_refused(self):
        self.refuse(entry(line_is=_ABSENT, line_contains="key"), "at least 4 characters")
        self.refuse(entry(line_is=_ABSENT, line_contains="WRAP_SALT "), "not a trimmed token")

    def test_an_unmodelled_within_value_is_refused(self):
        self.refuse(entry(line_is=_ABSENT, within="tests"), "field within must be one of test-module")

    def test_within_test_module_over_a_non_rust_path_is_refused(self):
        self.refuse(
            entry(path="plugin/test/**", line_is=_ABSENT, within="test-module", reason="used in tests"),
            "scopes `within: test-module` over a non-Rust file",
        )

    def test_used_in_tests_over_product_code_is_refused(self):
        for path in ("crates/obsyncd/src/api/auth.rs", "plugin/src/main.ts", "crates/**/*.rs"):
            with self.subTest(path=path):
                self.refuse(
                    entry(path=path, rule=CRYPTO_RULE, reason="used in tests"),
                    "dismisses product code as 'used in tests'",
                )

    def test_used_in_tests_is_accepted_over_a_test_location_or_a_test_module(self):
        for overrides in (
            {"path": "plugin/test/**", "rule": URL_RULE},
            {"path": "crates/**/*_test.rs"},
            {"path": "dashboard/test/**", "rule": URL_RULE},
            {"path": "scripts/ci/test_*.py", "rule": URL_RULE},
            {"path": "**/tests.rs"},
            {"path": "crates/**/*.rs", "within": "test-module"},
        ):
            with self.subTest(**overrides):
                cd.load_entries([entry(reason="used in tests", line_is=_ABSENT, **overrides)], TRACKED)

    def test_the_document_itself_is_closed(self):
        for document, expected in (
            ({"rule": CRYPTO_RULE}, "must be a JSON array"),
            ("[]", "must be a JSON array"),
            ([], "is empty"),
        ):
            with self.subTest(document=document):
                with self.assertRaises(cd.Refusal) as caught:
                    cd.load_entries(document, TRACKED)
                self.assertIn(expected, str(caught.exception))


class GlobSemantics(unittest.TestCase):
    """`*` stays inside one segment; `**` crosses them."""

    def matches(self, pattern: str, path: str) -> bool:
        return bool(cd.compile_glob(pattern, "test").fullmatch(path))

    def test_a_single_star_does_not_cross_a_separator(self):
        self.assertTrue(self.matches("plugin/test/*", "plugin/test/bundle.test.mjs"))
        self.assertFalse(self.matches("plugin/test/*", "plugin/test/sub/x.mjs"))
        self.assertFalse(self.matches("plugin/test/*", "plugin/test/fixtures/crypto.json"))

    def test_a_double_star_crosses_separators(self):
        self.assertTrue(self.matches("plugin/test/**", "plugin/test/bundle.test.mjs"))
        self.assertTrue(self.matches("plugin/test/**", "plugin/test/sub/x.mjs"))
        self.assertFalse(self.matches("plugin/test/**", "plugin/tests/x.mjs"))
        self.assertFalse(self.matches("plugin/test/**", "plugin/test"))

    def test_an_inner_double_star_spans_zero_or_more_segments(self):
        for path in ("crates/x.rs", "crates/a/x.rs", "crates/a/b/c/x.rs"):
            with self.subTest(path=path):
                self.assertTrue(self.matches("crates/**/*.rs", path))
        self.assertFalse(self.matches("crates/**/*.rs", "plugin/a/x.rs"))
        self.assertFalse(self.matches("crates/**/*.rs", "crates/a/x.ts"))

    def test_a_leading_double_star_matches_at_any_depth(self):
        self.assertTrue(self.matches("**/tests.rs", "tests.rs"))
        self.assertTrue(self.matches("**/tests.rs", "crates/obsyncd/src/storage/tests.rs"))
        self.assertFalse(self.matches("**/tests.rs", "crates/obsyncd/src/storage/mod.rs"))

    def test_a_literal_path_matches_only_itself(self):
        self.assertTrue(
            self.matches("crates/obsyncd/src/storage/mod.rs", "crates/obsyncd/src/storage/mod.rs")
        )
        self.assertFalse(
            self.matches("crates/obsyncd/src/storage/mod.rs", "crates/obsyncd/src/storage/mod.rsx")
        )


class SyntheticTree(unittest.TestCase):
    """Scope decisions read the real flagged line out of a real tree."""

    LIB = "\n".join(
        [
            "// 1 header",
            'const WRAP_SALT: &[u8] = b"obsync/v1/wrap";',  # 2
            "// 3",
            "fn product() -> u8 { 7 }",  # 4
            "",  # 5
            "#[cfg(test)]",  # 6
            "mod tests {",  # 7
            '    const VECTOR: &str = "000102";',  # 8
            "}",  # 9
        ]
    )

    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.root = Path(self.dir.name)
        (self.root / "crates/obsyncd/src/storage").mkdir(parents=True)
        (self.root / "crates/obsyncd/src/storage/mod.rs").write_text(self.LIB, encoding="utf-8")
        (self.root / "plugin/test").mkdir(parents=True)
        (self.root / "plugin/test/bundle.test.mjs").write_text("const u = 'x';\n", encoding="utf-8")
        self.tree = cd.Tree(self.root)
        self.addCleanup(self.dir.cleanup)

    def covers(self, raw: dict, hit: dict) -> bool:
        loaded = cd.load_entries([raw], TRACKED)[0]
        return cd.covers(loaded, load([hit], hit["most_recent_instance"]["ref"])[0], self.tree)

    TOKEN = entry(
        line_is=_ABSENT, line_contains="WRAP_SALT", reviewed_sha256=UNREAD_SHA256
    )

    def test_line_contains_reads_the_flagged_line(self):
        self.assertTrue(self.covers(self.TOKEN, alert(line=2)))
        for line in (1, 3, 4, 8):
            with self.subTest(line=line):
                self.assertFalse(self.covers(self.TOKEN, alert(line=line)))

    def test_line_is_compares_the_whole_trimmed_line_not_a_substring(self):
        # The line the entry names is line 2 of the fixture. An entry naming a
        # PART of it covers nothing: equality, not containment.
        self.assertTrue(self.covers(entry(), alert(line=2)))
        for line in (1, 3, 4, 8):
            with self.subTest(line=line):
                self.assertFalse(self.covers(entry(), alert(line=line)))
        for fragment in ("const WRAP_SALT", 'b"obsync/v1/wrap";', "WRAP_SALT"):
            with self.subTest(fragment=fragment):
                self.assertFalse(self.covers(entry(line_is=fragment), alert(line=2)))

    def test_line_is_ignores_indentation_on_both_sides(self):
        self.assertTrue(self.covers(entry(line_is=f"   {SALT_LINE}  "), alert(line=2)))

    def test_a_line_predicate_refuses_a_line_past_the_end_of_the_file(self):
        self.assertFalse(self.covers(self.TOKEN, alert(line=9999)))
        self.assertFalse(self.covers(entry(), alert(line=9999)))

    def test_a_line_predicate_refuses_a_file_that_is_not_there(self):
        with tempfile.TemporaryDirectory() as empty:
            loaded = cd.load_entries([entry()], TRACKED)[0]
            hit = load([alert(line=2)])[0]
            self.assertFalse(cd.covers(loaded, hit, cd.Tree(Path(empty))))

    def test_within_test_module_accepts_at_or_after_the_marker_and_refuses_above_it(self):
        scoped = entry(path="crates/**/*.rs", line_is=_ABSENT, within="test-module", reason="used in tests")
        for line in (6, 7, 8, 9):
            with self.subTest(line=line):
                self.assertTrue(self.covers(scoped, alert(line=line)))
        for line in (1, 2, 3, 4, 5):
            with self.subTest(line=line):
                self.assertFalse(self.covers(scoped, alert(line=line)))

    def test_within_test_module_refuses_a_file_with_no_marker(self):
        (self.root / "crates/obsyncd/src/api").mkdir(parents=True)
        (self.root / "crates/obsyncd/src/api/auth.rs").write_text("fn a() {}\n", encoding="utf-8")
        scoped = entry(path="crates/**/*.rs", line_is=_ABSENT, within="test-module", reason="used in tests")
        self.assertFalse(self.covers(scoped, alert(path="crates/obsyncd/src/api/auth.rs", line=1)))

    def test_an_unscoped_entry_covers_by_rule_and_path_alone(self):
        unscoped = entry(path="plugin/test/**", line_is=_ABSENT, rule=URL_RULE, reason="used in tests")
        self.assertTrue(
            self.covers(unscoped, alert(rule=URL_RULE, path="plugin/test/bundle.test.mjs", line=1))
        )
        self.assertFalse(
            self.covers(unscoped, alert(rule=URL_RULE, path="plugin/src/main.ts", line=1))
        )
        self.assertFalse(
            self.covers(unscoped, alert(rule=LOGGING_RULE, path="plugin/test/bundle.test.mjs"))
        )

    def test_a_flagged_path_outside_the_tree_is_refused_before_it_is_read(self):
        for path in ("/etc/passwd", "../outside.rs", "crates/../../outside.rs"):
            with self.subTest(path=path):
                with self.assertRaises(cd.Refusal) as caught:
                    load([alert(path=path)])
                self.assertIn("will not read", str(caught.exception))


class StrictTestModuleMarker(unittest.TestCase):
    """The scope opens at the trailing `#[cfg(test)] mod`, not at any attribute.

    This is the mistake the scope exists to not make. `api/auth.rs` puts
    `#[cfg(test)]` on a fake clock at line 59 and opens its test module at 464;
    `storage/mod.rs` carries the attribute on a fault enum, on a method, and on
    two `impl Store` blocks, and declares `mod tests;` near the top. Reading
    "the first `#[cfg(test)]`" as the marker would make every product line
    below it dismissible as a test vector -- the scope silently covering the
    thing it exists to exclude.
    """

    # An early attribute on a product item, product code below it, and the real
    # test module at the end. Line 4 is the attribute, 5 the struct, 8 a
    # product constant, 10 the module attribute, 11 the module.
    EARLY_ATTRIBUTE = "\n".join(
        [
            "//! a module",                                  # 1
            "use crate::x;",                                 # 2
            "",                                              # 3
            "#[cfg(test)]",                                  # 4
            "pub struct FakeClock;",                         # 5
            "",                                              # 6
            "/// product",                                   # 7
            'const REAL_KEY: &[u8] = b"product";',           # 8
            "",                                              # 9
            "#[cfg(test)]",                                  # 10
            "mod tests {",                                   # 11
            '    const VECTOR: &str = "000102";',            # 12
            "    fn t() {}",                                 # 13
            "}",                                             # 14
        ]
    )
    ONLY_ATTRIBUTE = "\n".join(
        [
            "#[cfg(test)]",                                  # 1
            "pub struct FakeClock;",                         # 2
            "",                                              # 3
            'const REAL_KEY: &[u8] = b"product";',           # 4
        ]
    )
    DECLARATION_NOT_LAST = "\n".join(
        [
            "#[cfg(test)]",                                  # 1
            "mod tests;",                                    # 2
            "",                                              # 3
            'const REAL_KEY: &[u8] = b"product";',           # 4
        ]
    )
    TRAILING_DECLARATION = "\n".join(
        [
            'const REAL_KEY: &[u8] = b"product";',           # 1
            "",                                              # 2
            "#[cfg(test)]",                                  # 3
            "mod tests;",                                    # 4
            "// nothing but comments after it",              # 5
        ]
    )
    INDENTED_ATTRIBUTE = "\n".join(
        [
            "impl Clock {",                                  # 1
            "    #[cfg(test)]",                              # 2
            "    mod inner {}",                              # 3
            "}",                                             # 4
            'const REAL_KEY: &[u8] = b"product";',           # 5
        ]
    )
    MODULE_THEN_MORE_CODE = "\n".join(
        [
            "#[cfg(test)]",                                  # 1
            "mod tests {",                                   # 2
            '    const VECTOR: &str = "0001";',              # 3
            "}",                                             # 4
            "",                                              # 5
            'const REAL_KEY: &[u8] = b"product";',           # 6
        ]
    )

    def marker(self, source: str) -> int | None:
        return cd.test_module_line(source.splitlines())

    def test_an_early_attribute_does_not_open_the_scope(self):
        self.assertEqual(self.marker(self.EARLY_ATTRIBUTE), 10)

    def test_a_file_whose_only_marker_is_an_attribute_opens_nothing(self):
        for name in ("ONLY_ATTRIBUTE", "INDENTED_ATTRIBUTE"):
            with self.subTest(source=name):
                self.assertIsNone(self.marker(getattr(self, name)))

    def test_a_module_that_is_not_the_last_top_level_item_opens_nothing(self):
        for name in ("DECLARATION_NOT_LAST", "MODULE_THEN_MORE_CODE"):
            with self.subTest(source=name):
                self.assertIsNone(self.marker(getattr(self, name)))

    def test_a_trailing_module_declaration_opens_the_scope(self):
        self.assertEqual(self.marker(self.TRAILING_DECLARATION), 3)

    def test_only_lines_inside_the_trailing_module_are_covered(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "crates/obsyncd/src/api").mkdir(parents=True)
            (root / "crates/obsyncd/src/api/auth.rs").write_text(
                self.EARLY_ATTRIBUTE, encoding="utf-8"
            )
            tree = cd.Tree(root)
            scoped = cd.load_entries(
                [entry(path="crates/**/*.rs", line_is=_ABSENT, within="test-module", reason="used in tests")],
                TRACKED,
            )[0]

            def covered(line: int) -> bool:
                hit = load([alert(path="crates/obsyncd/src/api/auth.rs", line=line)])[0]
                return cd.covers(scoped, hit, tree)

            # Between the early attribute and the module -- product code.
            for line in (4, 5, 8, 9):
                with self.subTest(line=line, expected="uncovered"):
                    self.assertFalse(covered(line))
            # The module and its body.
            for line in (10, 11, 12, 13):
                with self.subTest(line=line, expected="covered"):
                    self.assertTrue(covered(line))

    def test_a_file_with_no_trailing_module_covers_nothing(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "crates/obsyncd/src/api").mkdir(parents=True)
            (root / "crates/obsyncd/src/api/auth.rs").write_text(
                self.ONLY_ATTRIBUTE, encoding="utf-8"
            )
            tree = cd.Tree(root)
            scoped = cd.load_entries(
                [entry(path="crates/**/*.rs", line_is=_ABSENT, within="test-module", reason="used in tests")],
                TRACKED,
            )[0]
            for line in (1, 2, 4):
                with self.subTest(line=line):
                    hit = load([alert(path="crates/obsyncd/src/api/auth.rs", line=line)])[0]
                    self.assertFalse(cd.covers(scoped, hit, tree))


class CommandDecisions(unittest.TestCase):
    """`validate`, `check` and `plan` over files, with exit codes."""

    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.root = Path(self.dir.name)
        (self.root / "tree/crates/obsyncd/src/storage").mkdir(parents=True)
        (self.root / "tree/crates/obsyncd/src/storage/mod.rs").write_text(
            SyntheticTree.LIB, encoding="utf-8"
        )
        (self.root / "tree/plugin/test").mkdir(parents=True)
        (self.root / "tree/plugin/test/bundle.test.mjs").write_text("x\n", encoding="utf-8")
        self.tracked = self.root / "tracked.txt"
        self.tracked.write_text("\n".join(TRACKED) + "\n", encoding="utf-8")
        self.addCleanup(self.dir.cleanup)

    def files(self, entries: list[dict], alerts: list[dict]) -> tuple[str, str]:
        dispositions = self.root / "dispositions.json"
        dispositions.write_text(json.dumps(entries), encoding="utf-8")
        listing = self.root / "alerts.json"
        listing.write_text(json.dumps(alerts), encoding="utf-8")
        return str(dispositions), str(listing)

    def judged(
        self, dispositions: str, tree: str | None = None, commit: str = COMMIT
    ) -> list[str]:
        return [
            "--dispositions", dispositions,
            "--tree", tree or str(self.root / "tree"),
            "--content-tree", str(self.root / "tree"),
            "--tracked", str(self.tracked),
            "--commit", commit,
            "--analysis-key", ANALYSIS_KEY,
        ]

    def check(
        self,
        entries: list[dict],
        alerts: list[dict],
        ref: str = cd.MAIN_REF,
        states: str = "open",
        tree: str | None = None,
        commit: str = COMMIT,
    ):
        dispositions, listing = self.files(entries, alerts)
        return run_cli(
            ["check", *self.judged(dispositions, tree, commit), "--alerts", listing,
             "--ref", ref, "--states", states]
        )

    def plan(self, entries: list[dict], alerts: list[dict]):
        dispositions, listing = self.files(entries, alerts)
        return run_cli(["plan", *self.judged(dispositions), "--alerts", listing])

    def reconcile(self, entries: list[dict], alerts: list[dict], commit: str = COMMIT):
        dispositions, listing = self.files(entries, alerts)
        return run_cli(
            ["reconcile", *self.judged(dispositions, commit=commit), "--dismissed", listing]
        )

    def test_validate_accepts_a_good_file_and_names_every_entry(self):
        dispositions, _ = self.files([entry()], [])
        code, out, _ = run_cli(
            ["validate", "--dispositions", dispositions, "--tracked", str(self.tracked)]
        )
        self.assertEqual(code, 0)
        self.assertIn("entry=0 rule=rust/hard-coded-cryptographic-value", out)
        self.assertIn("decision=valid", out)

    def test_validate_exits_1_and_names_the_field_it_refused(self):
        dispositions, _ = self.files([entry(rule="rust/*")], [])
        code, _, err = run_cli(
            ["validate", "--dispositions", dispositions, "--tracked", str(self.tracked)]
        )
        self.assertEqual(code, 1)
        self.assertIn("entry 0 field rule is not one exact CodeQL rule id", err)

    def test_check_passes_when_every_alert_is_covered(self):
        code, out, _ = self.check([entry()], [alert(number=81, line=2)])
        self.assertEqual(code, 0)
        self.assertIn(
            "covered #81 rust/hard-coded-cryptographic-value "
            "crates/obsyncd/src/storage/mod.rs:2 state=open entry=0",
            out,
        )
        self.assertIn("uncovered=0 drift=0 stale_alerts=0 stale=0 decision=pass", out)

    def test_check_exits_1_and_names_every_uncovered_alert(self):
        code, out, err = self.check(
            [entry()],
            [alert(number=81, line=2), alert(number=90, line=4), alert(number=91, line=1)],
        )
        self.assertEqual(code, 1)
        self.assertIn("uncovered #90 rust/hard-coded-cryptographic-value", out)
        self.assertIn("crates/obsyncd/src/storage/mod.rs:4", out)
        self.assertIn("uncovered #91", out)
        self.assertIn("uncovered=2 drift=0 stale_alerts=0 stale=0 decision=refuse", out)
        self.assertIn("2 alert(s) no reviewed disposition covers", err)

    def test_check_reports_an_entry_that_matched_nothing(self):
        code, out, _ = self.check(
            [entry(), entry(rule=LOGGING_RULE, path="crates/**/*.rs")],
            [alert(number=81, line=2)],
        )
        self.assertEqual(code, 0)
        self.assertIn("stale entry=1 rule=rust/cleartext-logging path=crates/**/*.rs", out)
        self.assertNotIn("stale entry=0", out)
        self.assertIn("stale=1", out)

    def test_check_refuses_an_alert_analysed_on_another_ref(self):
        code, _, err = self.check(
            [entry()], [alert(number=81, line=2, ref=PR_REF)]
        )
        self.assertEqual(code, 1)
        self.assertIn(f"alert #81 was analysed on {PR_REF}, not {cd.MAIN_REF}", err)

    def test_check_reads_the_pull_request_ref_when_that_is_what_was_analysed(self):
        code, _, _ = self.check(
            [entry()], [alert(number=81, line=2, ref=PR_REF)], ref=PR_REF
        )
        self.assertEqual(code, 0)

    def test_check_refuses_an_alert_that_is_not_open(self):
        for state in ("dismissed", "fixed", "closed", None):
            with self.subTest(state=state):
                code, _, err = self.check(
                    [entry()], [alert(number=81, line=2, state=state)]
                )
                self.assertEqual(code, 1)
                self.assertIn("this listing was asked for open", err)

    def test_check_refuses_a_malformed_alert(self):
        good = alert(number=81, line=2)
        for mutation, expected in (
            ({"number": 0}, "no positive alert number"),
            ({"rule": {}}, "no readable rule id"),
            ({"most_recent_instance": {}}, "names no analysed ref"),
            (
                {"most_recent_instance": {"ref": cd.MAIN_REF, "commit_sha": COMMIT,
                                          "analysis_key": ANALYSIS_KEY}},
                "location is not an object",
            ),
            ({"most_recent_instance": {**alert()["most_recent_instance"],
                                       "commit_sha": "b" * 40}},
             "superseded or foreign"),
            ({"most_recent_instance": {**alert()["most_recent_instance"],
                                       "analysis_key": ".github/workflows/other.yml:scan"}},
             "superseded or foreign"),
        ):
            with self.subTest(mutation=sorted(mutation)):
                code, _, err = self.check([entry()], [{**good, **mutation}])
                self.assertEqual(code, 1)
                self.assertIn(expected, err)
        code, _, err = self.check([entry()], [{"number": 1}])
        self.assertEqual(code, 1)

    def test_plan_emits_exactly_the_covered_alerts_with_their_dismissal_fields(self):
        entries = [
            entry(),
            entry(path="plugin/test/**", line_is=_ABSENT, rule=URL_RULE,
                  reason="used in tests", comment="a string constant in a test bundle"),
        ]
        code, out, _ = self.plan(
            entries,
            [
                alert(number=81, line=2),
                alert(number=80, rule=URL_RULE, path="plugin/test/bundle.test.mjs", line=1),
                alert(number=99, line=4),
            ],
        )
        self.assertEqual(code, 0)
        emitted = [json.loads(line) for line in out.splitlines()]
        self.assertEqual(
            emitted,
            [
                {
                    "number": 81,
                    "reason": "false positive",
                    "comment": "a domain separator, not a secret",
                    "disposition": ISSUE,
                },
                {
                    "number": 80,
                    "reason": "used in tests",
                    "comment": "a string constant in a test bundle",
                    "disposition": ISSUE,
                },
            ],
        )
        for record in emitted:
            composed = f"{record['comment']}{cd.DISPOSITION_JOIN}{record['disposition']}"
            self.assertLessEqual(len(composed), cd.COMMENT_MAX)

    def test_plan_refuses_an_alert_that_was_not_analysed_on_main(self):
        code, out, err = self.plan(
            [entry()], [alert(number=81, line=2, ref=PR_REF)]
        )
        self.assertEqual(code, 1)
        self.assertEqual(out, "")
        self.assertIn(f"was analysed on {PR_REF}, not {cd.MAIN_REF}", err)

    def test_reconcile_reopens_a_dismissed_alert_no_entry_covers(self):
        # The state main is actually in when an entry is removed, narrowed, or
        # was never written: the finding is silent and nothing lists it again.
        code, out, _ = self.reconcile(
            [entry()],
            [
                alert(
                    number=90,
                    line=4,
                    state="dismissed",
                    dismissed_reason="false positive",
                    dismissed_comment="somebody typed this in the UI",
                )
            ],
        )
        self.assertEqual(code, 0)
        self.assertEqual(
            [json.loads(line) for line in out.splitlines()],
            [{"action": "reopen", "number": 90}],
        )

    def test_reconcile_rewrites_a_stored_justification_that_is_not_this_files(self):
        record = entry()
        for stored in (
            {"dismissed_reason": "won't fix"},
            {"dismissed_comment": "a different sentence"},
            {"dismissed_comment": None},
            {"dismissed_comment": record["comment"]},  # the URL half missing
        ):
            with self.subTest(stored=sorted(stored)):
                code, out, _ = self.reconcile(
                    [record], [dismissed(81, record, line=2, **stored)]
                )
                self.assertEqual(code, 0)
                self.assertEqual(
                    [json.loads(line) for line in out.splitlines()],
                    [
                        {
                            "action": "redismiss",
                            "number": 81,
                            "reason": record["reason"],
                            "comment": record["comment"],
                            "disposition": record["disposition"],
                        }
                    ],
                )

    def test_reconcile_leaves_a_dismissal_this_file_already_says_alone(self):
        record = entry()
        code, out, _ = self.reconcile([record], [dismissed(81, record, line=2)])
        self.assertEqual(code, 0)
        self.assertEqual(
            [json.loads(line) for line in out.splitlines()],
            [{"action": "unchanged", "number": 81}],
        )

    def test_reconcile_refuses_an_alert_that_is_open_or_off_main(self):
        record = entry()
        code, _, err = self.reconcile([record], [alert(number=81, line=2)])
        self.assertEqual(code, 1)
        self.assertIn("this listing was asked for dismissed", err)
        code, _, err = self.reconcile([record], [dismissed(81, record, line=2, ref=PR_REF)])
        self.assertEqual(code, 1)
        self.assertIn(f"was analysed on {PR_REF}", err)

    def test_check_reports_drift_naming_the_fields_that_differ(self):
        # The line has to say WHICH field drifted. Printing the reason alone
        # made all 78 of main's records read `reason='used in tests'
        # expected='used in tests'` -- a contradiction, because what differed
        # was the comment.
        record = entry()
        stored_comment = "a sentence somebody typed into the UI"
        for stored, fields, shows_reason in (
            ({"dismissed_reason": "won't fix"}, "reason", True),
            ({"dismissed_comment": stored_comment}, "comment", False),
            ({"dismissed_reason": "won't fix", "dismissed_comment": stored_comment},
             "reason,comment", True),
        ):
            with self.subTest(fields=fields):
                code, out, _ = self.check(
                    [record], [dismissed(81, record, line=2, **stored)], states="open,dismissed"
                )
                self.assertEqual(code, 0)
                self.assertIn("covered #81", out)
                self.assertIn(f"drift #81 entry=0 fields={fields}", out)
                self.assertIn("drift=1", out)
                # The stored comment is a whole sentence and never printed.
                self.assertNotIn(stored_comment, out)
                if shows_reason:
                    self.assertIn("reason=\"won't fix\" expected='false positive'", out)
                else:
                    self.assertNotIn("expected=", out)

    def test_check_reports_no_drift_when_the_record_already_agrees(self):
        record = entry()
        code, out, _ = self.check(
            [record], [dismissed(81, record, line=2)], states="open,dismissed"
        )
        self.assertEqual(code, 0)
        self.assertNotIn("drift #81", out)
        self.assertIn("drift=0", out)

    def test_check_fails_on_a_dismissed_alert_no_entry_covers(self):
        # The base check's whole purpose: an acceptance the branch already
        # relies on, deleted, is a finding that would be reopened on main.
        code, out, err = self.check(
            [entry()],
            [dismissed(90, entry(), line=4)],
            states="open,dismissed",
        )
        self.assertEqual(code, 1)
        self.assertIn("uncovered #90", out)
        self.assertIn("the next push to main would reopen it", out)
        self.assertIn("1 alert(s) no reviewed disposition covers", err)

    def test_entries_are_validated_against_the_files_of_the_tree_being_reviewed(self):
        # A pull request that adds a file AND its disposition in one change.
        # `--tracked` feeds only entry validation -- whether a glob names a
        # tracked place, whether a content hash names one file -- and those are
        # claims about the file being REVIEWED, which is the pull request's.
        # Handed the base branch's list instead, the same honest entry is
        # refused for naming a file the base does not have yet.
        added = "crates/obsyncd/src/cli/new_report.rs"
        record = entry(path=added, line_is='println!("new");', rule=LOGGING_RULE)
        self.tracked.write_text("\n".join([*TRACKED, added]) + "\n", encoding="utf-8")
        code, _, err = self.check([entry(), record], [])
        self.assertEqual(code, 0, err)
        self.tracked.write_text("\n".join(TRACKED) + "\n", encoding="utf-8")
        code, _, err = self.check([entry(), record], [])
        self.assertEqual(code, 1)
        self.assertIn(f"matches no tracked file: {added!r}", err)

    def test_an_alert_whose_instance_is_fixed_is_counted_and_left_alone(self):
        # GitHub keeps a dismissal after the code is gone and leaves the
        # instance on the last analysis that saw it -- an OLD commit, by
        # construction. Judging it would read a line number out of a tree
        # nobody is looking at, and reopening it would resurrect a finding the
        # tool says no longer exists.
        gone = dismissed(70, entry(), line=4, commit="0" * 40)
        gone["most_recent_instance"]["state"] = "fixed"
        code, out, _ = self.check([entry()], [gone], states="open,dismissed")
        self.assertEqual(code, 0)
        self.assertIn("stale #70 rust/hard-coded-cryptographic-value", out)
        self.assertIn("instance on 0000000", out)
        self.assertIn("alerts=0 covered=0 uncovered=0 drift=0 stale_alerts=1", out)
        code, out, _ = self.reconcile([entry()], [gone])
        self.assertEqual(code, 0)
        self.assertEqual(
            [json.loads(line) for line in out.splitlines()],
            [{"action": "stale", "number": 70}],
        )

    def stamped(self, **overrides: object) -> dict:
        """Alert #90 as `main` really carried it after v0.1.7 (issue #29).

        `state=dismissed`, instance `state=dismissed` on the PREVIOUS commit,
        this ref and this workflow's analysis key, and `fixed_at` stamped: the
        auth nonce vectors it covered were removed, so the analysis of the
        commit being judged no longer finds it and GitHub left the instance
        where it was last seen.
        """
        record = dismissed(
            90,
            entry(),
            path="crates/obsyncd/src/api/auth.rs",
            line=1038,
            commit=PREVIOUS_COMMIT,
            fixed_at=FIXED_AT,
        )
        record["most_recent_instance"]["state"] = "dismissed"
        record.update(overrides)
        return record

    def test_reconcile_counts_a_stamped_dismissal_left_on_the_previous_commit(self):
        # CALLER 1, THE PUSH PATH. THE LIVE DEFECT (issue #29): 33 of main's 78
        # dismissals were in this shape and `historical` only recognised
        # `instance.state == "fixed"`, so the commit binding refused the whole
        # run before anything was written -- and would have refused every push
        # to main forever. Completeness for this caller is the job's
        # wait-for-indexing step: both of THIS run's SARIFs reach
        # `processing_status: complete` before any listing is taken, so
        # `fixed_at` is the verdict of the analysis of `--commit`.
        code, out, err = self.reconcile([entry()], [self.stamped()])
        self.assertEqual(code, 0, err)
        self.assertEqual(
            [json.loads(line) for line in out.splitlines()],
            [{"action": "stale", "number": 90}],
        )

    def test_the_base_check_counts_a_stamped_dismissal_left_on_an_older_commit(self):
        # CALLER 2, THE PULL-REQUEST PATH, driven the way the workflow drives
        # it: `--states open,dismissed` over the BASE's alerts at the commit the
        # base's two analyses agree on, which is this caller's completeness
        # evidence -- this pull request's own uploads say nothing about main.
        # The same predicate answers, and nothing is judged.
        code, out, err = self.check(
            [entry()], [self.stamped()], states="open,dismissed", commit=BASE_ANALYSES_COMMIT
        )
        self.assertEqual(code, 0, err)
        self.assertIn(
            f"stale #90 rust/hard-coded-cryptographic-value "
            f"crates/obsyncd/src/api/auth.rs:1038 state=dismissed "
            f"fixed_at={FIXED_AT} instance on {PREVIOUS_COMMIT}",
            out,
        )
        self.assertIn("alerts=0 covered=0 uncovered=0 drift=0 stale_alerts=1", out)

    def test_neither_caller_exempts_an_unstamped_dismissal_on_another_commit(self):
        # THE KEY NEGATIVE, through both callers. `fixed_at` is what says the
        # finding is gone. Without it the record claims to be current and its
        # instance is not, which is the superseded or foreign case the refusal
        # exists for -- a stale location must never become its own excuse for
        # being stale.
        unstamped = self.stamped(fixed_at=None)
        code, _, err = self.reconcile([entry()], [unstamped])
        self.assertEqual(code, 1)
        self.assertIn(f"was analysed on commit {PREVIOUS_COMMIT}, not {COMMIT}", err)
        self.assertIn("superseded or foreign", err)
        code, _, err = self.check(
            [entry()], [unstamped], states="open,dismissed", commit=BASE_ANALYSES_COMMIT
        )
        self.assertEqual(code, 1)
        self.assertIn(f"was analysed on commit {PREVIOUS_COMMIT}, not {BASE_ANALYSES_COMMIT}", err)
        self.assertIn("superseded or foreign", err)

    def test_the_ref_and_the_analysis_bind_whatever_the_stamp_says(self):
        # A record from another branch or another workflow is foreign in every
        # state: no stamp makes it this file's business.
        for overrides, expected in (
            ({"key": ".github/workflows/other.yml:analyze"}, "came from analysis"),
            ({"ref": PR_REF}, f"was analysed on {PR_REF}, not {cd.MAIN_REF}"),
        ):
            with self.subTest(foreign=sorted(overrides)):
                foreign = self.stamped()
                foreign["most_recent_instance"].update(
                    {"analysis_key": overrides.get("key", ANALYSIS_KEY),
                     "ref": overrides.get("ref", cd.MAIN_REF)}
                )
                code, _, err = self.check([entry()], [foreign], states="dismissed")
                self.assertEqual(code, 1)
                self.assertIn(expected, err)

    def test_an_open_alert_on_another_commit_is_refused_however_it_is_stamped(self):
        # The exemption is for DISMISSED records only. An open finding the
        # analysis no longer detects is one GitHub calls fixed; an open alert
        # pointing at another commit is superseded or foreign.
        for stamp in (None, FIXED_AT):
            for instance_state in ("open", "dismissed", None):
                with self.subTest(fixed_at=stamp, instance=instance_state):
                    old = alert(number=90, line=2, commit=PREVIOUS_COMMIT, fixed_at=stamp)
                    if instance_state is not None:
                        old["most_recent_instance"]["state"] = instance_state
                    code, _, err = self.check([entry()], [old], states="open,dismissed")
                    self.assertEqual(code, 1)
                    self.assertIn("was analysed on commit", err)
                    self.assertIn("superseded or foreign", err)

    def test_a_stamped_dismissal_on_the_judged_commit_is_judged_as_before(self):
        # The stamp is not a way out of the file's authority: what has an
        # instance on the commit being judged is judged, drift and all.
        drifted = dismissed(
            81, entry(), line=2, fixed_at=FIXED_AT, dismissed_comment="typed in the UI"
        )
        code, out, err = self.reconcile([entry()], [drifted])
        self.assertEqual(code, 0, err)
        self.assertEqual(
            [json.loads(line)["action"] for line in out.splitlines()], ["redismiss"]
        )
        agreed = dismissed(81, entry(), line=2, fixed_at=FIXED_AT)
        code, out, err = self.reconcile([entry()], [agreed])
        self.assertEqual(code, 0, err)
        self.assertEqual(
            [json.loads(line) for line in out.splitlines()],
            [{"action": "unchanged", "number": 81}],
        )

    def test_a_fixed_at_that_is_not_a_timestamp_or_null_is_refused(self):
        for stamp in (12345, "", [], {}, True):
            with self.subTest(fixed_at=stamp):
                code, _, err = self.check(
                    [entry()], [self.stamped(fixed_at=stamp)], states="dismissed"
                )
                self.assertEqual(code, 1)
                self.assertIn(
                    "field fixed_at is neither a non-empty string nor null", err
                )

    def test_check_refuses_a_states_value_it_does_not_model(self):
        for states in ("fixed", "open,fixed", "open,open", ""):
            with self.subTest(states=states):
                code, _, err = self.check([entry()], [], states=states)
                self.assertEqual(code, 1)
                self.assertIn("--states must be a comma-separated subset", err)

    def test_plan_is_empty_and_successful_when_main_holds_no_open_alert(self):
        code, out, _ = self.plan([entry()], [])
        self.assertEqual(code, 0)
        self.assertEqual(out, "")


class TheShippedFile(unittest.TestCase):
    """The committed dispositions, against the committed tree."""

    @classmethod
    def setUpClass(cls):
        cls.tracked = subprocess.run(
            ["git", "ls-files"], cwd=ROOT, capture_output=True, text=True, check=True
        ).stdout.splitlines()
        cls.entries = cd.load_entries(
            json.loads(DISPOSITIONS.read_text(encoding="utf-8")), cls.tracked
        )
        cls.tree = cd.Tree(ROOT)

    def test_the_file_is_tracked_and_every_entry_validates_against_git_ls_files(self):
        self.assertIn("security/codeql-dispositions.json", self.tracked)
        self.assertGreaterEqual(len(self.entries), 1)
        for entry_ in self.entries:
            with self.subTest(entry=entry_.index):
                self.assertGreaterEqual(entry_.matches, 1)
                self.assertLessEqual(len(entry_.dismissal_comment), cd.COMMENT_MAX)

    def test_the_salt_disposition_covers_the_line_the_salt_is_actually_on(self):
        # Alert #81. Located by content rather than by a line number so the
        # pin follows the constant instead of breaking when the file grows.
        source = (ROOT / "crates/obsyncd/src/storage/mod.rs").read_text(encoding="utf-8")
        lines = source.splitlines()
        declared = [n for n, line in enumerate(lines, 1) if line.startswith("const WRAP_SALT")]
        self.assertEqual(len(declared), 1, "exactly one WRAP_SALT declaration")
        hit = load(
            [alert(number=81, path="crates/obsyncd/src/storage/mod.rs", line=declared[0])]
        )[0]
        covering = [e for e in self.entries if cd.covers(e, hit, self.tree)]
        self.assertEqual([e.reason for e in covering[:1]], ["false positive"])
        self.assertTrue(covering[0].disposition.endswith("/20"))

    def test_the_test_vector_disposition_covers_a_line_inside_a_test_module_only(self):
        source = (ROOT / "crates/obsyncd/src/api/auth.rs").read_text(encoding="utf-8")
        marker = cd.test_module_line(source.splitlines())
        self.assertIsNotNone(marker)
        inside = load([alert(number=1, path="crates/obsyncd/src/api/auth.rs", line=marker + 1)])[0]
        above = load([alert(number=2, path="crates/obsyncd/src/api/auth.rs", line=marker - 1)])[0]
        self.assertTrue(any(cd.covers(e, inside, self.tree) for e in self.entries))
        self.assertFalse(any(cd.covers(e, above, self.tree) for e in self.entries))

    def test_the_whole_file_test_module_disposition_covers_the_dedicated_test_file(self):
        # crates/obsyncd/src/api/server_test.rs carries NO `#[cfg(test)]` line
        # of its own -- its parent declares it as `#[cfg(test)] mod
        # server_test;` -- so the test-module scope cannot reach it and the
        # test-location entry is what covers alert #32.
        path = "crates/obsyncd/src/api/server_test.rs"
        self.assertIsNone(cd.test_module_line((ROOT / path).read_text(encoding="utf-8").splitlines()))
        hit = load([alert(number=32, path=path, line=1)])[0]
        covering = [e for e in self.entries if cd.covers(e, hit, self.tree)]
        self.assertEqual([e.reason for e in covering[:1]], ["used in tests"])

    def test_the_scope_opens_below_the_early_attributes_in_the_shipped_tree(self):
        # The property, not the line numbers: in every file the test-vector
        # entry covers, the scope opens at the trailing test module, and in the
        # two files that carry an early `#[cfg(test)]` on a product item it
        # opens strictly below that attribute. `storage/mod.rs` declares
        # `mod tests;` near the top and keeps going for a thousand lines, so it
        # opens NO scope at all and its one alert is covered by the salt entry.
        def markers(path: str) -> tuple[int | None, int | None]:
            lines = (ROOT / path).read_text(encoding="utf-8").splitlines()
            first = next(
                (n for n, line in enumerate(lines, 1) if line.strip().startswith("#[cfg(test)]")),
                None,
            )
            return cd.test_module_line(lines), first

        for path in ("crates/obsyncd/src/api/auth.rs", "crates/obsyncd/src/api/pairing.rs"):
            with self.subTest(path=path):
                strict, first = markers(path)
                self.assertIsNotNone(strict)
                self.assertIsNotNone(first)
                self.assertGreater(strict, first, "the scope must open below the early attribute")
                opened = (ROOT / path).read_text(encoding="utf-8").splitlines()[strict]
                self.assertTrue(opened.startswith("mod "), opened)
        strict, first = markers("crates/obsync-core/src/hkdf.rs")
        self.assertEqual(strict, first, "hkdf.rs opens with its test module")
        self.assertIsNone(markers("crates/obsyncd/src/storage/mod.rs")[0])

    def test_every_shipped_alert_class_is_covered_by_the_entry_that_claims_it(self):
        # One synthetic alert per class the repository has actually produced,
        # at a line located by content. `cli/check.rs` and `cli/export.rs` are
        # PRODUCT code: their entries are `false positive` over the report
        # printer, never `used in tests`.
        def line_of(path: str, needle: str) -> int:
            lines = (ROOT / path).read_text(encoding="utf-8").splitlines()
            hits = [n for n, line in enumerate(lines, 1) if needle in line]
            self.assertTrue(hits, f"{needle} not found in {path}")
            return hits[0]

        for rule, path, line, reason in (
            (
                CRYPTO_RULE,
                "crates/obsyncd/src/storage/mod.rs",
                line_of("crates/obsyncd/src/storage/mod.rs", "const WRAP_SALT"),
                "false positive",
            ),
            (URL_RULE, "plugin/test/bundle.test.mjs", 1, "used in tests"),
            (
                CRYPTO_RULE,
                "crates/obsyncd/src/api/auth.rs",
                cd.test_module_line(
                    (ROOT / "crates/obsyncd/src/api/auth.rs").read_text(encoding="utf-8").splitlines()
                )
                + 2,
                "used in tests",
            ),
            (CRYPTO_RULE, "crates/obsyncd/src/api/server_test.rs", 1, "used in tests"),
            (
                LOGGING_RULE,
                "crates/obsyncd/src/cli/check.rs",
                line_of("crates/obsyncd/src/cli/check.rs", "chunks verified"),
                "false positive",
            ),
            (
                LOGGING_RULE,
                "crates/obsyncd/src/cli/export.rs",
                line_of("crates/obsyncd/src/cli/export.rs", "files written"),
                "false positive",
            ),
        ):
            with self.subTest(rule=rule, path=path):
                hit = load([alert(rule=rule, path=path, line=line)])[0]
                covering = [e for e in self.entries if cd.covers(e, hit, self.tree)]
                self.assertTrue(covering, f"nothing covers {hit}")
                self.assertEqual(covering[0].reason, reason)

    def test_a_report_entry_covers_no_line_outside_the_report(self):
        # `line_contains: "println!"` is only honest while every `println!` in
        # those two files is the operator report. This is that claim, pinned:
        # when it stops holding, the triage in issue #23 has to be redone.
        for path, printer in (
            ("crates/obsyncd/src/cli/check.rs", "impl CheckReport {"),
            ("crates/obsyncd/src/cli/export.rs", "impl ExportReport {"),
        ):
            with self.subTest(path=path):
                lines = (ROOT / path).read_text(encoding="utf-8").splitlines()
                start = lines.index("    pub fn print(&self) {") + 1
                self.assertIn(printer, lines)
                end = next(n for n, line in enumerate(lines[start:], start + 1) if line == "    }")
                printed = [n for n, line in enumerate(lines, 1) if "println!" in line]
                self.assertTrue(printed)
                self.assertEqual(
                    [n for n in printed if not start <= n <= end],
                    [],
                    "every println! in this file must be inside the operator report",
                )
                # And a line that is not part of the report is not covered.
                hit = load([alert(rule=LOGGING_RULE, path=path, line=1)])[0]
                self.assertFalse(any(cd.covers(e, hit, self.tree) for e in self.entries))

    def test_no_shipped_entry_dismisses_product_code_as_used_in_tests(self):
        # The validator refuses it, and this is the same claim asserted over
        # the file that ships rather than over a fixture.
        for entry_ in self.entries:
            if entry_.reason != "used in tests":
                continue
            with self.subTest(entry=entry_.index):
                matched = [path for path in self.tracked if entry_.glob.fullmatch(path)]
                self.assertTrue(matched)
                if entry_.within is None:
                    self.assertTrue(all(cd._is_test_location(path) for path in matched))


class ReviewedContent(unittest.TestCase):
    """An acceptance over product code names what was read, and it is re-read.

    Finding 3 of the round-1 verdict: entry 4 accepted any flagged `println!`
    in `cli/check.rs`, so a harmless new output inserted inside
    `CheckReport::print` was accepted with no policy change, and a REAL logging
    finding added there later would inherit the same false-positive verdict.
    The location test could not see it: the new call was inside the method.
    """

    PRINTERS = ("crates/obsyncd/src/cli/check.rs", "crates/obsyncd/src/cli/export.rs")

    @classmethod
    def setUpClass(cls):
        cls.tracked = subprocess.run(
            ["git", "ls-files"], cwd=ROOT, capture_output=True, text=True, check=True
        ).stdout.splitlines()
        cls.shipped = json.loads(DISPOSITIONS.read_text(encoding="utf-8"))

    def content_tree(self, root: Path, edits: dict[str, str] | None = None) -> Path:
        """The reviewed files, byte-identical unless an edit says otherwise."""
        tree = root / "content"
        for path in (*self.PRINTERS, "crates/obsyncd/src/storage/mod.rs"):
            target = tree / path
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes((ROOT / path).read_bytes())
        for path, text in (edits or {}).items():
            (tree / path).write_text(text, encoding="utf-8")
        return tree

    def run_check(self, tree: Path, entries: list[dict] | None = None):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "dispositions.json").write_text(
                json.dumps(self.shipped if entries is None else entries), encoding="utf-8"
            )
            (root / "alerts.json").write_text("[]", encoding="utf-8")
            (root / "tracked.txt").write_text("\n".join(self.tracked) + "\n", encoding="utf-8")
            return run_cli(
                [
                    "check",
                    "--dispositions", str(root / "dispositions.json"),
                    "--alerts", str(root / "alerts.json"),
                    "--tree", str(ROOT),
                    "--content-tree", str(tree),
                    "--tracked", str(root / "tracked.txt"),
                    "--ref", cd.MAIN_REF,
                    "--commit", COMMIT,
                    "--analysis-key", ANALYSIS_KEY,
                    "--states", "open",
                ]
            )

    def test_the_shipped_hashes_are_the_shipped_files(self):
        for record in self.shipped:
            if "reviewed_sha256" not in record:
                continue
            with self.subTest(path=record["path"]):
                digest = hashlib.sha256((ROOT / record["path"]).read_bytes()).hexdigest()
                self.assertEqual(record["reviewed_sha256"], digest)

    def test_the_content_is_verified_even_when_no_alert_touches_the_file(self):
        # Zero alerts in the listing. The hash is still read, because the guard
        # is about the reviewed CONTENT, not about today's findings.
        with tempfile.TemporaryDirectory() as tmp:
            unchanged = self.content_tree(Path(tmp))
            code, _, _ = self.run_check(unchanged)
            self.assertEqual(code, 0)
        with tempfile.TemporaryDirectory() as tmp:
            edited = self.content_tree(
                Path(tmp),
                {self.PRINTERS[0]: (ROOT / self.PRINTERS[0]).read_text(encoding="utf-8") + "\n"},
            )
            code, _, err = self.run_check(edited)
            self.assertEqual(code, 1)
            self.assertIn("differs from the reviewed content", err)
            self.assertIn("re-triage https://github.com/snaraj/obsync/issues/23", err)

    def test_a_new_output_inside_the_report_method_is_refused(self):
        # The exact mutation that survived round 1: one more `println!` INSIDE
        # `CheckReport::print`, where the location pin still passes.
        source = (ROOT / self.PRINTERS[0]).read_text(encoding="utf-8")
        anchor = '        println!("chunks verified: {}", self.chunks);\n'
        self.assertIn(anchor, source)
        mutated = source.replace(
            anchor, anchor + '        println!("harmless: {}", self.bytes);\n'
        )
        with tempfile.TemporaryDirectory() as tmp:
            code, _, err = self.run_check(self.content_tree(Path(tmp), {self.PRINTERS[0]: mutated}))
            self.assertEqual(code, 1, "a new output in a reviewed printer must force re-triage")
            self.assertIn(self.PRINTERS[0], err)

    def test_a_missing_reviewed_file_is_refused(self):
        with tempfile.TemporaryDirectory() as tmp:
            tree = self.content_tree(Path(tmp))
            (tree / self.PRINTERS[1]).unlink()
            code, _, err = self.run_check(tree)
            self.assertEqual(code, 1)
            self.assertIn("is not readable in the tree being judged", err)

    def test_an_acceptance_over_product_code_must_name_what_was_reviewed(self):
        product = "crates/obsyncd/src/cli/check.rs"
        for record, expected in (
            (entry(path=product, line_is=_ABSENT, rule=LOGGING_RULE), "without naming what was reviewed"),
            (
                entry(path=product, line_is=_ABSENT, line_contains="println!", rule=LOGGING_RULE),
                "without naming what was reviewed",
            ),
            (entry(path="crates/**/*.rs", line_is=_ABSENT), "without naming what was reviewed"),
        ):
            with self.subTest(record=record.get("path"), scope=sorted(record)):
                with self.assertRaises(cd.Refusal) as caught:
                    cd.load_entries([record], self.tracked)
                self.assertIn(expected, str(caught.exception))
        # Either binding satisfies it, and a test-scoped entry needs neither.
        for record in (
            entry(path=product, line_is=_ABSENT, rule=LOGGING_RULE, reviewed_sha256=UNREAD_SHA256),
            entry(path=product, line_is="println!(\"chunks failed:   {}\", self.bad_chunks.len());",
                  rule=LOGGING_RULE),
            entry(path="plugin/test/**", line_is=_ABSENT, rule=URL_RULE, reason="used in tests"),
            entry(path="crates/**/*.rs", line_is=_ABSENT, within="test-module",
                  reason="used in tests"),
        ):
            with self.subTest(scope=sorted(record)):
                cd.load_entries([record], self.tracked)

    def test_a_content_hash_needs_one_file_and_a_real_digest(self):
        for record, expected in (
            (
                entry(path="crates/**/*.rs", line_is=_ABSENT, reviewed_sha256=UNREAD_SHA256),
                "its path is not one tracked file",
            ),
            (entry(reviewed_sha256="ABC"), "not a lowercase hex sha256"),
            (entry(reviewed_sha256=UNREAD_SHA256.upper()), "not a lowercase hex sha256"),
        ):
            with self.subTest(expected=expected):
                with self.assertRaises(cd.Refusal) as caught:
                    cd.load_entries([record], self.tracked)
                self.assertIn(expected, str(caught.exception))


def flat(script: str) -> str:
    """One line, line continuations joined, so a pin reads like the command."""
    return " ".join(re.sub(r"\\\s*\n", " ", script).split())


class WorkflowWiring(unittest.TestCase):
    """The narrow wiring that makes the decision effective, read as YAML."""

    @classmethod
    def setUpClass(cls):
        cls.text = WORKFLOW.read_text(encoding="utf-8")
        cls.document = miniyaml.load_one(cls.text)
        cls.job = cls.document["jobs"]["dispositions"]
        cls.steps = cls.job["steps"]
        cls.names = [step.get("name") for step in cls.steps]

    def step(self, name: str) -> dict:
        return self.steps[self.names.index(name)]

    def test_the_job_exists_needs_the_analysis_and_holds_exactly_two_permissions(self):
        self.assertEqual(self.job["needs"], "analyze")
        self.assertEqual(self.job["permissions"], {"contents": "read", "security-events": "write"})
        self.assertEqual(self.job["runs-on"], "ubuntu-24.04")
        self.assertEqual(self.job["timeout-minutes"], 15)
        self.assertEqual(self.job["env"], {"GH_TOKEN": "${{ github.token }}"})

    def test_the_checkout_keeps_no_credential(self):
        checkout = self.step("Check out repository")
        self.assertTrue(checkout["uses"].startswith("actions/checkout@"))
        self.assertIs(checkout["with"]["persist-credentials"], False)

    def test_the_analysis_records_a_sarif_id_per_language_for_this_job_to_wait_on(self):
        analyze = self.document["jobs"]["analyze"]
        self.assertEqual(
            analyze["outputs"],
            {
                "sarif-id-rust": "${{ steps.record.outputs.sarif-id-rust }}",
                "sarif-id-javascript-typescript": (
                    "${{ steps.record.outputs.sarif-id-javascript-typescript }}"
                ),
            },
        )
        steps = {step.get("name"): step for step in analyze["steps"]}
        self.assertEqual(steps["Analyze"]["id"], "analyze")
        record = steps["Record the SARIF id this analysis uploaded"]
        self.assertEqual(record["id"], "record")
        self.assertEqual(record["env"]["SARIF_ID"], "${{ steps.analyze.outputs.sarif-id }}")
        script = flat(record["run"])
        self.assertIn('test -n "${SARIF_ID}"', script)
        self.assertIn('printf \'sarif-id-%s=%s\\n\' "${LANGUAGE}" "${SARIF_ID}" >> "${GITHUB_OUTPUT}"', script)

    def test_the_indexing_wait_precedes_the_listing_and_every_decision(self):
        order = [
            self.names.index(name)
            for name in (
                "Wait for GitHub to index both analyses",
                "List the open alerts on the analysed ref",
                "Validate the disposition file",
                "Refuse any open alert no disposition covers",
                "Dismiss every covered alert and require main to hold none",
            )
        ]
        self.assertEqual(order, sorted(order))

    def test_the_wait_polls_both_ids_against_a_budget_and_refuses_a_failed_upload(self):
        wait = self.step("Wait for GitHub to index both analyses")
        self.assertNotIn("if", wait)
        self.assertEqual(
            wait["env"],
            {
                "SARIF_ID_RUST": "${{ needs.analyze.outputs.sarif-id-rust }}",
                "SARIF_ID_JAVASCRIPT_TYPESCRIPT": (
                    "${{ needs.analyze.outputs.sarif-id-javascript-typescript }}"
                ),
            },
        )
        script = flat(wait["run"])
        self.assertIn("budget=600", script)
        self.assertIn("interval=15", script)
        self.assertIn("for language in rust javascript-typescript; do", script)
        self.assertIn(
            'gh api "repos/${GITHUB_REPOSITORY}/code-scanning/sarifs/${sarif_id}" '
            "--jq '.processing_status'",
            script,
        )
        self.assertIn("analysis not indexed; alerts cannot be judged", script)

    def test_the_listing_slurps_one_array_for_the_ref_that_was_analysed(self):
        script = flat(self.step("List the open alerts on the analysed ref")["run"])
        self.assertIn('ref="refs/pull/${PR_NUMBER}/merge"', script)
        self.assertIn('ref="refs/heads/main"', script)
        self.assertIn('git ls-files > "${RUNNER_TEMP}/tracked.txt"', script)
        self.assertIn(
            'gh api --paginate "repos/${GITHUB_REPOSITORY}/code-scanning/alerts'
            '?state=open&ref=${ref}&per_page=100" --jq \'.[]\' | jq -s . '
            '> "${RUNNER_TEMP}/alerts.json"',
            script,
        )

    def test_the_check_runs_on_every_event_with_no_guard(self):
        check = self.step("Refuse any open alert no disposition covers")
        self.assertNotIn("if", check)
        script = flat(check["run"])
        self.assertIn("python3 -I -B scripts/ci/codeql_dispositions.py check", script)
        for flag in (
            "--dispositions security/codeql-dispositions.json",
            '--alerts "${RUNNER_TEMP}/alerts.json"',
            "--tree .",
            '--tracked "${RUNNER_TEMP}/tracked.txt"',
            '--ref "${ref}"',
        ):
            with self.subTest(flag=flag):
                self.assertIn(flag, script)

    def test_the_dismissal_is_guarded_to_pushes_and_requires_main_to_hold_none(self):
        dismiss = self.step("Dismiss every covered alert and require main to hold none")
        self.assertIn("github.event_name == 'push'", dismiss["if"])
        script = flat(dismiss["run"])
        self.assertIn("python3 -I -B scripts/ci/codeql_dispositions.py plan", script)
        self.assertIn(
            'gh api -X PATCH "repos/${GITHUB_REPOSITORY}/code-scanning/alerts/${number}" '
            '-f state=dismissed -f dismissed_reason="${reason}" '
            '-f dismissed_comment="${comment} Disposition: ${disposition}"',
            script,
        )
        self.assertIn('if [ -n "${remaining}" ]; then', script)
        self.assertIn("main still holds open code-scanning alerts", script)
        self.assertIn("exit 1", script)

    def test_every_guard_is_exactly_the_event_it_names(self):
        # The whole guard inventory in one assertion: the three base-branch
        # steps run only on a pull request, the dismissal only on a push, and
        # nothing else carries an `if:` at all. A guard removed, added, or
        # pointed at the wrong event fails here.
        guarded = {name: step["if"] for name, step in zip(self.names, self.steps) if "if" in step}
        self.assertEqual(
            guarded,
            {
                "List main's dismissed alerts": "github.event_name == 'push'",
                "List the open alerts on the base branch": "github.event_name == 'pull_request'",
                "Check out the base branch as a second tree": "github.event_name == 'pull_request'",
                "Reconcile main's dismissed alerts with this file": (
                    "github.event_name == 'push'"
                ),
                "Refuse any base-branch alert this file stops covering": (
                    "github.event_name == 'pull_request'"
                ),
                "Dismiss every covered alert and require main to hold none": (
                    "github.event_name == 'push'"
                ),
            },
        )

    def test_the_reconciliation_runs_before_the_check_that_would_catch_it(self):
        # Order is the guarantee: reopening turns drift into an uncovered open
        # alert, and only a check that runs AFTERWARDS sees it.
        order = [
            self.names.index(name)
            for name in (
                "List main's dismissed alerts",
                "Reconcile main's dismissed alerts with this file",
                "Refuse any open alert no disposition covers",
                "Dismiss every covered alert and require main to hold none",
            )
        ]
        self.assertEqual(order, sorted(order))
        script = flat(self.step("Reconcile main's dismissed alerts with this file")["run"])
        self.assertIn("python3 -I -B scripts/ci/codeql_dispositions.py reconcile", script)
        self.assertIn('--dismissed "${RUNNER_TEMP}/dismissed.json"', script)
        self.assertIn(
            'gh api -X PATCH "repos/${GITHUB_REPOSITORY}/code-scanning/alerts/${number}" '
            "-f state=open",
            script,
        )
        self.assertIn("-f state=dismissed", script)
        # A rewrite is TWO writes, reopen first, each announcing its phase:
        # GitHub refuses `state=dismissed` on an already-dismissed alert.
        self.assertIn(
            "printf 'dispositions: redismiss alert=%s phase=reopen\\n' \"${number}\" "
            'gh api -X PATCH "repos/${GITHUB_REPOSITORY}/code-scanning/alerts/${number}" '
            "-f state=open > /dev/null "
            "printf 'dispositions: redismiss alert=%s phase=dismiss\\n' \"${number}\" "
            'gh api -X PATCH "repos/${GITHUB_REPOSITORY}/code-scanning/alerts/${number}" '
            "-f state=dismissed",
            script,
        )
        # And it re-reads main's open alerts, so anything reopened above is in
        # front of the check that follows.
        self.assertIn(
            'gh api --paginate "repos/${GITHUB_REPOSITORY}/code-scanning/alerts'
            '?state=open&ref=refs/heads/main&per_page=100" --jq \'.[]\' | jq -s . '
            '> "${RUNNER_TEMP}/alerts.json"',
            script,
        )
        self.assertIn("dispositions: reconcile reopened=%d redismissed=%d unchanged=%d", script)
        listing = flat(self.step("List main's dismissed alerts")["run"])
        self.assertIn("state=dismissed&ref=refs/heads/main", listing)

    def test_every_judged_alert_is_bound_to_a_commit_and_this_analysis(self):
        for name, commit in (
            ("Refuse any open alert no disposition covers", '--commit "${GITHUB_SHA}"'),
            ("Reconcile main's dismissed alerts with this file", '--commit "${GITHUB_SHA}"'),
            ("Dismiss every covered alert and require main to hold none", '--commit "${GITHUB_SHA}"'),
            ("Refuse any base-branch alert this file stops covering", '--commit "${commit}"'),
        ):
            with self.subTest(step=name):
                script = flat(self.step(name)["run"])
                self.assertIn(commit, script)
                self.assertIn("--analysis-key .github/workflows/codeql.yml:analyze", script)

    def test_a_pull_request_also_lists_the_base_branchs_open_alerts(self):
        # GitHub's pull-request analyses are diff-informed: the merge ref only
        # carries findings inside the changed range, so main's open alerts are
        # invisible there and a file that stops covering one of them would be
        # green on the PR and red on main after the merge.
        script = flat(self.step("List the open alerts on the base branch")["run"])
        self.assertIn('test -n "${GITHUB_BASE_REF}"', script)
        self.assertIn('ref="refs/heads/${GITHUB_BASE_REF}"', script)
        # Open AND dismissed: an acceptance the base already relies on is
        # invisible in an open-only listing, and deleting it would be silent.
        for state in ("open", "dismissed"):
            with self.subTest(state=state):
                self.assertIn(
                    'gh api --paginate "repos/${GITHUB_REPOSITORY}/code-scanning/alerts'
                    f'?state={state}&ref=${{ref}}&per_page=100" --jq \'.[]\'',
                    script,
                )
        self.assertIn('| jq -s . > "${RUNNER_TEMP}/alerts-base.json"', script)
        # And the commit the base's analyses describe, per language, refusing
        # to proceed when the two legs disagree.
        self.assertIn(
            'gh api --paginate "repos/${GITHUB_REPOSITORY}/code-scanning/analyses'
            '?ref=${ref}&per_page=50"',
            script,
        )
        self.assertIn("for language in rust javascript-typescript; do", script)
        self.assertIn("base analyses disagree", script)
        self.assertIn('printf \'%s\\n\' "${commit}" > "${RUNNER_TEMP}/base-commit.txt"', script)
        self.assertIn("dispositions: DONE step=list-base-alerts", script)

    def test_the_base_tree_is_a_worktree_whose_tracked_list_is_its_own(self):
        script = flat(self.step("Check out the base branch as a second tree")["run"])
        # The COMMIT the analyses ran on, not the branch tip: alert lines are
        # line numbers in that commit.
        self.assertIn('commit="$(cat "${RUNNER_TEMP}/base-commit.txt")"', script)
        self.assertIn('git fetch --depth=1 origin "${commit}"', script)
        self.assertIn('git worktree add --detach "${RUNNER_TEMP}/base-tree" "${commit}"', script)
        self.assertNotIn("FETCH_HEAD", script)
        self.assertNotIn('origin "${GITHUB_BASE_REF}"', script)
        self.assertIn(
            'git -C "${RUNNER_TEMP}/base-tree" ls-files > "${RUNNER_TEMP}/base-tracked.txt"',
            script,
        )

    def test_the_base_check_reads_this_files_entries_in_the_base_tree(self):
        script = flat(self.step("Refuse any base-branch alert this file stops covering")["run"])
        self.assertIn("python3 -I -B scripts/ci/codeql_dispositions.py check", script)
        # This pull request's file, never the base branch's own copy -- that
        # copy is the version being replaced, so judging with it would prove
        # nothing about the change.
        self.assertIn("--dispositions security/codeql-dispositions.json", script)
        self.assertNotIn("base-tree/security", script)
        for flag in (
            '--alerts "${RUNNER_TEMP}/alerts-base.json"',
            '--tree "${RUNNER_TEMP}/base-tree"',
            '--tracked "${RUNNER_TEMP}/tracked.txt"',
            '--ref "${ref}"',
        ):
            with self.subTest(flag=flag):
                self.assertIn(flag, script)
        self.assertNotIn("--tree .", script)
        order = [
            self.names.index(name)
            for name in (
                "List the open alerts on the base branch",
                "Check out the base branch as a second tree",
                "Refuse any base-branch alert this file stops covering",
            )
        ]
        self.assertEqual(order, sorted(order))

    def test_every_step_logs_a_start_and_a_done_line(self):
        for step in self.steps:
            if "run" not in step:
                continue
            with self.subTest(step=step["name"]):
                script = step["run"]
                self.assertIn("dispositions: START step=", script)
                self.assertIn("dispositions: DONE step=", script)
                self.assertIn("duration=%ds", script)

    def test_nothing_is_excluded_from_analysis(self):
        # The whole point of the disposition file is that CodeQL keeps
        # scanning everything: an exclusion would remove the finding instead of
        # accepting it, and would do so without a reviewed reason. Read as
        # RESOLVED KEYS, at any depth, so a prose mention of the construct in a
        # comment is not a failure and a real one anywhere is.
        excluding = {"query-filters", "paths-ignore", "paths", "config-file", "config", "queries"}

        def walk(node: object, where: str) -> None:
            if isinstance(node, dict):
                for key, value in node.items():
                    self.assertNotIn(key, excluding, f"{where}.{key} excludes code from analysis")
                    walk(value, f"{where}.{key}")
            elif isinstance(node, list):
                for position, item in enumerate(node):
                    walk(item, f"{where}[{position}]")

        walk(self.document, "codeql.yml")
        initialize = {step.get("name"): step for step in self.document["jobs"]["analyze"]["steps"]}
        self.assertEqual(
            set(initialize["Initialize CodeQL"]["with"]), {"languages", "build-mode"}
        )


GH_STUB = r"""#!/bin/sh
# A STATEFUL stand-in for the gh shapes this job uses. Every alert lives as one
# record in ${STUB_STATE}/<number>.json -- its state, its dismissed reason and
# its dismissed comment -- and a write changes that record ONLY when it
# succeeds. Listings are generated from those records, so a reopen is visible
# to the next listing, and a second invocation of the harness meets exactly
# what the first one left behind.
#
# IT MODELS THE REFUSAL THAT STOPPED THE FIRST LIVE RECONCILE. A
# `state=dismissed` write to an alert that is ALREADY dismissed answers
# `gh: Alert is already dismissed. (HTTP 400)` and exits non-zero. #25's
# stand-in accepted every PATCH and its test expected exactly the single
# dismissed-to-dismissed write GitHub rejects, which is why that shape passed
# the suite and then failed on main with 78 rewrites planned (issue #26).
#
# `state=open` on an already-open record is a no-op success, the way the API
# treats a transition to the state a record is already in. STUB_PATCH_FAIL
# names a phase (`open` or `dismissed`) whose write fails, so a run can be
# interrupted BETWEEN the two writes and the leftover state inspected.
printf 'gh %s\n' "$*" >> "${STUB_LOG}"
[ -n "${STUB_GH_FAIL:-}" ] && exit 4
patch=0
target=""
filter=""
wanted=""
reason=""
comment=""
previous=""
for argument in "$@"; do
  case "${argument}" in
    PATCH) patch=1 ;;
    repos/*) target="${argument}" ;;
    state=*) wanted="${argument#state=}" ;;
    dismissed_reason=*) reason="${argument#dismissed_reason=}" ;;
    dismissed_comment=*) comment="${argument#dismissed_comment=}" ;;
  esac
  [ "${previous}" = "--jq" ] && filter="${argument}"
  previous="${argument}"
done
if [ "${patch}" -eq 1 ]; then
  record="${STUB_STATE}/${target##*/}.json"
  if [ ! -f "${record}" ]; then
    echo "gh: Not Found (HTTP 404)" >&2
    exit 1
  fi
  if [ "${wanted}" = "dismissed" ] && [ "$(jq -r .state "${record}")" = "dismissed" ]; then
    echo "gh: Alert is already dismissed. (HTTP 400)" >&2
    exit 1
  fi
  if [ "${STUB_PATCH_FAIL:-}" = "${wanted}" ]; then
    echo "gh: Server Error (HTTP 502)" >&2
    exit 1
  fi
  jq --arg state "${wanted}" --arg reason "${reason}" --arg comment "${comment}" \
    'if $state == "dismissed"
       then .state = $state | .dismissed_reason = $reason | .dismissed_comment = $comment
       else .state = $state | .dismissed_reason = null | .dismissed_comment = null
     end' "${record}" > "${record}.new" && mv "${record}.new" "${record}"
  exit 0
fi
case "${target}" in
  *code-scanning/sarifs/*)
    status="$(head -n 1 "${STUB_SARIF_STATUS}")"
    tail -n +2 "${STUB_SARIF_STATUS}" > "${STUB_SARIF_STATUS}.rest"
    [ -s "${STUB_SARIF_STATUS}.rest" ] && mv "${STUB_SARIF_STATUS}.rest" "${STUB_SARIF_STATUS}"
    rm -f "${STUB_SARIF_STATUS}.rest"
    printf '%s\n' "${status}" ;;
  *code-scanning/analyses*)
    cat "${STUB_ANALYSES}" ;;
  *code-scanning/alerts*)
    query="${target#*\?}"
    state=""
    ref=""
    saved="${IFS}"
    IFS='&'
    for pair in ${query}; do
      case "${pair}" in
        state=*) state="${pair#state=}" ;;
        ref=*) ref="${pair#ref=}" ;;
      esac
    done
    IFS="${saved}"
    records="$(cat "${STUB_STATE}"/*.json 2>/dev/null || true)"
    [ -z "${records}" ] && exit 0
    if [ "${filter}" = ".[]" ]; then
      printf '%s' "${records}" | jq -s -c --arg s "${state}" --arg r "${ref}" \
        'map(select(.state == $s and .most_recent_instance.ref == $r)) | sort_by(.number) | .[]'
    else
      printf '%s' "${records}" | jq -s -r --arg s "${state}" --arg r "${ref}" \
        'map(select(.state == $s and .most_recent_instance.ref == $r)) | sort_by(.number) | .[]
         | "#\(.number) \(.rule.id) \(.most_recent_instance.location.path):\(.most_recent_instance.location.start_line)"'
    fi ;;
  *) echo "unexpected gh call: $*" >&2; exit 64 ;;
esac
"""

SLEEP_STUB = r"""#!/bin/sh
# The poll interval, recorded rather than waited out.
printf 'sleep %s\n' "$*" >> "${STUB_LOG}"
exit 0
"""

GIT_STUB = r"""#!/bin/sh
# Stand-in for the three git shapes this job uses. `ls-files` answers from a
# staged list; the base-branch worktree is materialised from a staged fixture,
# because the production step fetches it over the network.
printf 'git %s\n' "$*" >> "${STUB_LOG}"
case "$1" in
  ls-files) cat "${STUB_TRACKED}"; exit 0 ;;
  fetch) exit 0 ;;
  worktree)
    [ "$2" = "add" ] || { echo "unexpected git call: $*" >&2; exit 64; }
    mkdir -p "$4"
    cp -R "${STUB_BASE_TREE}/." "$4/"
    exit 0 ;;
  -C)
    shift 2
    [ "$1" = "ls-files" ] || { echo "unexpected git call: $*" >&2; exit 64; }
    cat "${STUB_BASE_TRACKED}"
    exit 0 ;;
esac
echo "unexpected git call: $*" >&2
exit 64
"""

# The base branch's copy of `crates/obsyncd/src/cli/check.rs`, where the report
# printer sits at a DIFFERENT line from this checkout's. An alert at line 3 is
# covered when judged in this tree and uncovered when judged in the pull
# request's, which is what makes "judge in the tree the finding came from"
# a testable claim rather than a comment.
BASE_CHECK_RS = "// the base branch's copy\n// of the report printer\n" '        println!("chunks verified: {}", self.chunks);\n'


class StepExecution(unittest.TestCase):
    """The production steps, executed: a refusal is fatal, not a log line."""

    @classmethod
    def setUpClass(cls):
        document = miniyaml.load_one(WORKFLOW.read_text(encoding="utf-8"))
        cls.steps = {
            step.get("name"): step
            for job in document["jobs"].values()
            for step in job.get("steps", [])
        }
        for tool in ("bash", "jq", "git", "python3"):
            if shutil.which(tool) is None:
                raise AssertionError(f"{tool} is required to execute these steps (the runner has it)")
        source = (ROOT / "crates/obsyncd/src/storage/mod.rs").read_text(encoding="utf-8")
        cls.salt_line = next(
            n for n, line in enumerate(source.splitlines(), 1) if line.startswith("const WRAP_SALT")
        )

    HEAD_SHA = "e" * 40
    BASE_COMMIT = "d" * 40

    def covered_alerts(self) -> list[dict]:
        return [
            alert(
                number=81,
                path="crates/obsyncd/src/storage/mod.rs",
                line=self.salt_line,
                commit=self.HEAD_SHA,
            ),
            alert(
                number=80,
                rule=URL_RULE,
                path="plugin/test/bundle.test.mjs",
                line=103,
                commit=self.HEAD_SHA,
            ),
        ]

    def analyses(self, commits: tuple[str, str] | None = None) -> list[dict]:
        rust, javascript = commits or (self.BASE_COMMIT, self.BASE_COMMIT)
        return [
            {
                "id": index,
                "category": f".github/workflows/codeql.yml:analyze/build-mode:none/language:{lang}",
                "commit_sha": commit,
                "ref": cd.MAIN_REF,
            }
            for index, (lang, commit) in enumerate(
                (("rust", rust), ("javascript-typescript", javascript)), start=1
            )
        ]

    @classmethod
    def tracked(cls) -> str:
        return subprocess.run(
            ["git", "ls-files"], cwd=ROOT, capture_output=True, text=True, check=True
        ).stdout

    def stage(
        self,
        root: Path,
        *,
        event: str = "push",
        statuses: tuple[str, ...] = ("complete",),
        alerts: list[dict] | None = None,
        remaining: str = "",
        base_alerts: list[dict] | None = None,
        base_dismissed: list[dict] | None = None,
        base_dispositions: list[dict] | None = None,
        dismissed_alerts: list[dict] | None = None,
        analyses: list[dict] | None = None,
    ) -> dict:
        bins, temp = root / "bin", root / "runner-temp"
        bins.mkdir()
        temp.mkdir()
        for name, body in (("gh", GH_STUB), ("sleep", SLEEP_STUB), ("git", GIT_STUB)):
            path = bins / name
            path.write_text(body)
            path.chmod(0o755)
        (root / "sarif-status").write_text("\n".join(statuses) + "\n")
        (root / "tracked.txt").write_text(self.tracked())
        (root / "base-tracked.txt").write_text(
            "".join(
                line + "\n"
                for line in self.tracked().splitlines()
                if line != "crates/obsyncd/src/cli/export.rs"
            )
        )
        # THE ONLY SOURCE OF ALERTS. Every listing the stand-in answers is
        # generated from these records, so a write this run makes is what the
        # next listing -- and the next run of the harness -- sees.
        state = root / "alert-state"
        state.mkdir()
        for record in [
            *(self.covered_alerts() if alerts is None else alerts),
            *(dismissed_alerts or []),
            *(base_alerts or []),
            *(base_dismissed or []),
        ]:
            (state / f"{record['number']}.json").write_text(json.dumps(record), encoding="utf-8")
        (root / "analyses.jsonl").write_text(
            "".join(
                json.dumps(a) + "\n"
                for a in (self.analyses() if analyses is None else analyses)
            )
        )
        # The base branch's tree: the report printer at a different line, and
        # its own copy of the disposition file -- the version this pull request
        # is replacing, which the base check must never read.
        base_tree = root / "base-tree"
        (base_tree / "crates/obsyncd/src/cli").mkdir(parents=True)
        (base_tree / "crates/obsyncd/src/cli/check.rs").write_text(BASE_CHECK_RS, encoding="utf-8")
        (base_tree / "security").mkdir()
        (base_tree / "security/codeql-dispositions.json").write_text(
            json.dumps(
                base_dispositions
                if base_dispositions is not None
                else [
                    e
                    for e in json.loads(DISPOSITIONS.read_text(encoding="utf-8"))
                    if e["path"] != "crates/obsyncd/src/cli/check.rs"
                ]
            ),
            encoding="utf-8",
        )
        environment = {
            "PATH": f"{bins}{os.pathsep}{os.environ['PATH']}",
            "HOME": str(root),
            "LANG": "C",
            "RUNNER_TEMP": str(temp),
            "GITHUB_REPOSITORY": "snaraj/obsync",
            "GITHUB_EVENT_NAME": event,
            "GITHUB_BASE_REF": "main" if event == "pull_request" else "",
            "GITHUB_SHA": self.HEAD_SHA,
            "PR_NUMBER": "23" if event == "pull_request" else "",
            "SARIF_ID_RUST": "sarif-rust",
            "SARIF_ID_JAVASCRIPT_TYPESCRIPT": "sarif-js",
            "STUB_LOG": str(root / "calls.log"),
            "STUB_SARIF_STATUS": str(root / "sarif-status"),
            "STUB_ANALYSES": str(root / "analyses.jsonl"),
            "STUB_STATE": str(root / "alert-state"),
            "STUB_TRACKED": str(root / "tracked.txt"),
            # Deliberately NOT the same list: the base branch is missing a file
            # a shipped entry names, which is what a pull request adding a file
            # and its disposition together looks like from the base's side.
            # Every executed base check therefore proves which list it used.
            "STUB_BASE_TRACKED": str(root / "base-tracked.txt"),
            "STUB_BASE_TREE": str(base_tree),
        }
        return environment

    def stored(self, env: dict, number: int) -> dict:
        """The record the stand-in holds now -- the persisted truth, not a count."""
        return json.loads(
            (Path(env["STUB_STATE"]) / f"{number}.json").read_text(encoding="utf-8")
        )

    def run_step(self, name: str, env: dict) -> subprocess.CompletedProcess:
        script = Path(env["RUNNER_TEMP"]).parent / f"{abs(hash(name)) % 10**8}.sh"
        script.write_text(self.steps[name]["run"])
        # GitHub runs an un-shelled `run:` as `bash -e {0}`; the bodies add
        # `set -euo pipefail` themselves.
        return subprocess.run(
            ["bash", "--noprofile", "--norc", "-e", str(script)],
            cwd=ROOT,
            env=env,
            capture_output=True,
            text=True,
            timeout=120,
        )

    def calls(self, env: dict, prefix: str) -> list[str]:
        log = Path(env["STUB_LOG"])
        return [line for line in log.read_text().splitlines() if line.startswith(prefix)] if log.exists() else []

    WAIT = "Wait for GitHub to index both analyses"
    LIST = "List the open alerts on the analysed ref"
    BASE_LIST = "List the open alerts on the base branch"
    BASE_TREE = "Check out the base branch as a second tree"
    VALIDATE = "Validate the disposition file"
    CHECK = "Refuse any open alert no disposition covers"
    BASE_CHECK = "Refuse any base-branch alert this file stops covering"
    DISMISSED_LIST = "List main's dismissed alerts"
    RECONCILE = "Reconcile main's dismissed alerts with this file"
    DISMISS = "Dismiss every covered alert and require main to hold none"

    @classmethod
    def base_alert(cls, line: int = 3, **overrides: object) -> dict:
        return alert(
            number=40,
            rule=LOGGING_RULE,
            path="crates/obsyncd/src/cli/check.rs",
            line=line,
            ref=cd.MAIN_REF,
            commit=cls.BASE_COMMIT,
            **overrides,
        )

    def test_the_wait_polls_until_both_analyses_are_indexed(self):
        with tempfile.TemporaryDirectory() as tmp:
            env = self.stage(Path(tmp), statuses=("pending", "pending", "complete"))
            result = self.run_step(self.WAIT, env)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(len(self.calls(env, "gh api repos/snaraj/obsync/code-scanning/sarifs/")), 4)
            self.assertEqual(self.calls(env, "sleep"), ["sleep 15", "sleep 15"])
            self.assertIn("dispositions: indexed language=rust", result.stdout)
            self.assertIn("dispositions: indexed language=javascript-typescript", result.stdout)
            self.assertIn("decision=indexed", result.stdout)

    def test_the_wait_refuses_a_failed_upload_without_judging_anything(self):
        with tempfile.TemporaryDirectory() as tmp:
            env = self.stage(Path(tmp), statuses=("failed",))
            result = self.run_step(self.WAIT, env)
            self.assertNotEqual(result.returncode, 0, "a failed analysis must stop the job")
            self.assertIn("analysis not indexed; alerts cannot be judged", result.stderr)
            self.assertNotIn("decision=indexed", result.stdout)

    def test_the_wait_gives_up_inside_its_budget_rather_than_polling_forever(self):
        with tempfile.TemporaryDirectory() as tmp:
            env = self.stage(Path(tmp), statuses=("pending",))
            result = self.run_step(self.WAIT, env)
            self.assertNotEqual(result.returncode, 0, "an unindexed analysis must stop the job")
            self.assertIn("analysis not indexed; alerts cannot be judged", result.stderr)
            self.assertEqual(len(self.calls(env, "sleep")), 39, "600s budget at a 15s interval")

    def test_the_wait_refuses_a_language_that_recorded_no_sarif_id(self):
        with tempfile.TemporaryDirectory() as tmp:
            env = self.stage(Path(tmp))
            result = self.run_step(self.WAIT, {**env, "SARIF_ID_JAVASCRIPT_TYPESCRIPT": ""})
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("javascript-typescript recorded no SARIF id", result.stderr)

    def test_the_listing_writes_one_array_and_the_ref_it_was_taken_on(self):
        with tempfile.TemporaryDirectory() as tmp:
            env = self.stage(Path(tmp))
            self.assertEqual(self.run_step(self.LIST, env).returncode, 0)
            temp = Path(env["RUNNER_TEMP"])
            self.assertEqual(
                json.loads((temp / "alerts.json").read_text()),
                sorted(self.covered_alerts(), key=lambda record: record["number"]),
            )
            self.assertEqual((temp / "alerts-ref.txt").read_text().strip(), "refs/heads/main")
            self.assertIn("security/codeql-dispositions.json", (temp / "tracked.txt").read_text())

    def test_the_listing_takes_the_merge_ref_on_a_pull_request(self):
        with tempfile.TemporaryDirectory() as tmp:
            env = self.stage(Path(tmp), event="pull_request", alerts=[])
            result = self.run_step(self.LIST, env)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(
                (Path(env["RUNNER_TEMP"]) / "alerts-ref.txt").read_text().strip(),
                "refs/pull/23/merge",
            )
            self.assertIn("ref=refs/pull/23/merge", " ".join(self.calls(env, "gh api --paginate")))

    def test_the_shipped_file_validates_in_the_step_that_ships_it(self):
        with tempfile.TemporaryDirectory() as tmp:
            env = self.stage(Path(tmp))
            self.assertEqual(self.run_step(self.LIST, env).returncode, 0)
            result = self.run_step(self.VALIDATE, env)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn("decision=valid", result.stdout)

    def test_the_check_step_passes_when_every_open_alert_is_covered(self):
        with tempfile.TemporaryDirectory() as tmp:
            env = self.stage(Path(tmp))
            self.assertEqual(self.run_step(self.LIST, env).returncode, 0)
            result = self.run_step(self.CHECK, env)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn("covered #81", result.stdout)
            self.assertIn("covered #80", result.stdout)
            self.assertIn("decision=covered", result.stdout)

    def test_the_check_step_fails_the_job_on_one_uncovered_alert(self):
        with tempfile.TemporaryDirectory() as tmp:
            # A product-code logging alert in a file no entry names: exactly
            # the new real finding this gate exists to stop.
            listing = self.covered_alerts() + [
                alert(number=900, rule=LOGGING_RULE, path="crates/obsyncd/src/log.rs", line=1,
                      commit=self.HEAD_SHA)
            ]
            env = self.stage(Path(tmp), alerts=listing)
            self.assertEqual(self.run_step(self.LIST, env).returncode, 0)
            result = self.run_step(self.CHECK, env)
            self.assertNotEqual(result.returncode, 0, "an uncovered alert must fail the step")
            self.assertIn("uncovered #900 rust/cleartext-logging", result.stdout)
            self.assertNotIn("decision=covered", result.stdout)

    def test_a_push_dismisses_exactly_the_covered_alerts_and_then_requires_none(self):
        with tempfile.TemporaryDirectory() as tmp:
            env = self.stage(Path(tmp))
            self.assertEqual(self.run_step(self.LIST, env).returncode, 0)
            result = self.run_step(self.DISMISS, env)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(len(self.calls(env, "gh api -X PATCH")), 2)
            # The PERSISTED record, not the command: state, reason, and the
            # composed comment the entry actually carries.
            shipped = json.loads(DISPOSITIONS.read_text(encoding="utf-8"))
            for number, record in ((80, shipped[1]), (81, shipped[0])):
                with self.subTest(alert=number):
                    held = self.stored(env, number)
                    self.assertEqual(held["state"], "dismissed")
                    self.assertEqual(held["dismissed_reason"], record["reason"])
                    self.assertEqual(
                        held["dismissed_comment"],
                        f"{record['comment']}{cd.DISPOSITION_JOIN}{record['disposition']}",
                    )
            self.assertIn("dismissed=2 remaining=0", result.stdout)

    def test_a_push_fails_when_main_still_holds_an_open_alert_afterwards(self):
        with tempfile.TemporaryDirectory() as tmp:
            # An open alert nothing covers, left standing in the stand-in's
            # own state after the covered ones are dismissed.
            env = self.stage(
                Path(tmp),
                alerts=[
                    *self.covered_alerts(),
                    alert(
                        number=900,
                        rule=LOGGING_RULE,
                        path="crates/obsyncd/src/log.rs",
                        line=1,
                        commit=self.HEAD_SHA,
                    ),
                ],
            )
            self.assertEqual(self.run_step(self.LIST, env).returncode, 0)
            result = self.run_step(self.DISMISS, env)
            self.assertNotEqual(result.returncode, 0, "a remaining open alert must fail the job")
            self.assertIn("main still holds open code-scanning alerts", result.stderr)
            self.assertIn("#900 rust/cleartext-logging", result.stderr)

    def test_a_pull_request_writes_nothing(self):
        with tempfile.TemporaryDirectory() as tmp:
            env = self.stage(
                Path(tmp), event="pull_request", alerts=[], base_alerts=[self.base_alert()]
            )
            for name in (
                self.WAIT,
                self.LIST,
                self.BASE_LIST,
                self.BASE_TREE,
                self.VALIDATE,
                self.CHECK,
                self.BASE_CHECK,
            ):
                with self.subTest(step=name):
                    result = self.run_step(name, env)
                    self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(self.calls(env, "gh api -X PATCH"), [])
            self.assertIsNone(
                self.steps[self.CHECK].get("if"), "the check must not be guarded off a pull request"
            )
            self.assertIn("github.event_name == 'push'", self.steps[self.DISMISS]["if"])

    def test_a_pull_request_judges_the_base_branchs_alerts_in_the_base_tree(self):
        # The alert main holds is invisible on the merge ref, so the base
        # listing is what puts it in front of this file at all -- and line 3 is
        # the report printer in the BASE tree only.
        with tempfile.TemporaryDirectory() as tmp:
            env = self.stage(
                Path(tmp), event="pull_request", alerts=[], base_alerts=[self.base_alert()]
            )
            for name in (self.LIST, self.BASE_LIST, self.BASE_TREE):
                self.assertEqual(self.run_step(name, env).returncode, 0)
            temp = Path(env["RUNNER_TEMP"])
            self.assertEqual(json.loads((temp / "alerts.json").read_text()), [])
            self.assertEqual(
                json.loads((temp / "alerts-base.json").read_text()), [self.base_alert()]
            )
            self.assertEqual((temp / "alerts-base-ref.txt").read_text().strip(), cd.MAIN_REF)
            self.assertEqual(
                (temp / "base-tree/crates/obsyncd/src/cli/check.rs").read_text(), BASE_CHECK_RS
            )
            result = self.run_step(self.BASE_CHECK, env)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn("covered #40 rust/cleartext-logging", result.stdout)
            self.assertIn("dispositions: DONE step=check-base-coverage", result.stdout)

    def test_the_same_base_alert_is_uncovered_when_judged_in_the_pull_requests_tree(self):
        # The other half of the claim: line 3 of THIS checkout's check.rs is a
        # doc comment, so judging the base branch's finding here would refuse
        # it. That is why the base check reads the base tree.
        same_finding_on_the_merge_ref = alert(
            number=40,
            rule=LOGGING_RULE,
            path="crates/obsyncd/src/cli/check.rs",
            line=3,
            ref="refs/pull/23/merge",
            commit=self.HEAD_SHA,
        )
        with tempfile.TemporaryDirectory() as tmp:
            env = self.stage(
                Path(tmp), event="pull_request", alerts=[same_finding_on_the_merge_ref]
            )
            self.assertEqual(self.run_step(self.LIST, env).returncode, 0)
            result = self.run_step(self.CHECK, env)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("uncovered #40 rust/cleartext-logging", result.stdout)

    def test_the_base_check_fails_when_this_file_stops_covering_a_base_alert(self):
        with tempfile.TemporaryDirectory() as tmp:
            env = self.stage(
                Path(tmp), event="pull_request", alerts=[], base_alerts=[self.base_alert(line=1)]
            )
            for name in (self.LIST, self.BASE_LIST, self.BASE_TREE):
                self.assertEqual(self.run_step(name, env).returncode, 0)
            result = self.run_step(self.BASE_CHECK, env)
            self.assertNotEqual(
                result.returncode, 0, "an uncovered base alert must fail before the merge"
            )
            self.assertIn("uncovered #40 rust/cleartext-logging", result.stdout)
            self.assertIn("crates/obsyncd/src/cli/check.rs:1", result.stdout)

    def test_a_push_reopens_before_it_rewrites_a_stored_justification(self):
        # THE LIVE DEFECT, at the shape main was actually in: 78 dismissals
        # whose comments were typed by hand before this file existed. GitHub
        # refuses `state=dismissed` on an already-dismissed alert, so each
        # rewrite is a reopen followed by a dismiss, in that order, per alert.
        shipped = json.loads(DISPOSITIONS.read_text(encoding="utf-8"))
        salt, bundle = self.covered_alerts()

        def stored(record: dict, **fields: object) -> dict:
            return {**record, "state": "dismissed", **fields}

        foreign = {"dismissed_reason": "used in tests", "dismissed_comment": "typed in the UI"}
        agreed = {
            "dismissed_reason": shipped[0]["reason"],
            "dismissed_comment": f"{shipped[0]['comment']}"
            f"{cd.DISPOSITION_JOIN}{shipped[0]['disposition']}",
        }
        gone = stored({**salt, "number": 78}, **foreign)
        gone["most_recent_instance"] = {
            **gone["most_recent_instance"], "state": "fixed", "commit_sha": "0" * 40,
        }
        listing = [
            stored(salt, **foreign),                      # 81 -> redismiss
            stored(bundle, **foreign),                    # 80 -> redismiss
            stored({**salt, "number": 79}, **agreed),     # 79 -> unchanged
            gone,                                         # 78 -> stale
        ]
        with tempfile.TemporaryDirectory() as tmp:
            env = self.stage(Path(tmp), dismissed_alerts=listing)
            self.assertEqual(self.run_step(self.LIST, env).returncode, 0)
            self.assertEqual(self.run_step(self.DISMISSED_LIST, env).returncode, 0)
            result = self.run_step(self.RECONCILE, env)
            self.assertEqual(result.returncode, 0, result.stderr)
            patches = self.calls(env, "gh api -X PATCH")
            self.assertEqual(len(patches), 4, "two writes per rewrite, and no others")
            for number, record in ((80, shipped[1]), (81, shipped[0])):
                with self.subTest(alert=number):
                    mine = [line for line in patches if f"/alerts/{number} " in line]
                    self.assertEqual(len(mine), 2, "one reopen and one dismiss")
                    self.assertIn("-f state=open", mine[0])
                    self.assertIn("-f state=dismissed", mine[1])
                    # The phases are logged, and in the order they are sent.
                    self.assertEqual(
                        [
                            line
                            for line in result.stdout.splitlines()
                            if line.startswith(f"dispositions: redismiss alert={number} ")
                        ],
                        [
                            f"dispositions: redismiss alert={number} phase=reopen",
                            f"dispositions: redismiss alert={number} phase=dismiss",
                        ],
                    )
                    # And the PERSISTED record is what the entry says.
                    held = self.stored(env, number)
                    self.assertEqual(held["state"], "dismissed")
                    self.assertEqual(held["dismissed_reason"], record["reason"])
                    self.assertEqual(
                        held["dismissed_comment"],
                        f"{record['comment']}{cd.DISPOSITION_JOIN}{record['disposition']}",
                    )
            # The two the file already agreed with, and the one whose finding is
            # gone, are untouched.
            self.assertEqual(self.stored(env, 79)["dismissed_comment"], agreed["dismissed_comment"])
            self.assertEqual(self.stored(env, 78)["dismissed_comment"], foreign["dismissed_comment"])
            self.assertIn(
                "dispositions: reconcile reopened=0 redismissed=2 unchanged=1 stale=1",
                result.stdout,
            )

    def test_each_kind_of_drift_causes_the_transition_and_agreement_causes_none(self):
        # Reason-only and comment-only drift each earn the real two-write
        # transition; a record that already says what the file says is a no-op.
        shipped = json.loads(DISPOSITIONS.read_text(encoding="utf-8"))[0]
        composed = f"{shipped['comment']}{cd.DISPOSITION_JOIN}{shipped['disposition']}"
        salt = self.covered_alerts()[0]
        for label, stored_fields, writes in (
            ("reason-only", {"dismissed_reason": "won't fix", "dismissed_comment": composed}, 2),
            (
                "comment-only",
                {"dismissed_reason": shipped["reason"], "dismissed_comment": "typed in the UI"},
                2,
            ),
            (
                "agreed",
                {"dismissed_reason": shipped["reason"], "dismissed_comment": composed},
                0,
            ),
        ):
            with self.subTest(drift=label), tempfile.TemporaryDirectory() as tmp:
                env = self.stage(
                    Path(tmp), dismissed_alerts=[{**salt, "state": "dismissed", **stored_fields}]
                )
                self.assertEqual(self.run_step(self.LIST, env).returncode, 0)
                self.assertEqual(self.run_step(self.DISMISSED_LIST, env).returncode, 0)
                result = self.run_step(self.RECONCILE, env)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(len(self.calls(env, "gh api -X PATCH")), writes)
                held = self.stored(env, 81)
                self.assertEqual(held["state"], "dismissed")
                self.assertEqual(held["dismissed_reason"], shipped["reason"])
                self.assertEqual(held["dismissed_comment"], composed)

    def test_a_reopened_record_reaches_the_listing_and_then_fails_the_check(self):
        # Nothing is pre-staged as open: the reconcile REOPENS it, the listing
        # the same step takes afterwards reads it back from the stand-in, and
        # the check that follows refuses it. That chain is the reason reopening
        # is the mutation this design chose.
        stray = alert(
            number=900,
            rule=LOGGING_RULE,
            path="crates/obsyncd/src/log.rs",
            line=1,
            state="dismissed",
            commit=self.HEAD_SHA,
            dismissed_reason="false positive",
            dismissed_comment="typed into the UI, recorded nowhere",
        )
        with tempfile.TemporaryDirectory() as tmp:
            env = self.stage(Path(tmp), dismissed_alerts=[stray])
            self.assertEqual(self.run_step(self.LIST, env).returncode, 0)
            self.assertEqual(
                json.loads((Path(env["RUNNER_TEMP"]) / "alerts.json").read_text()),
                sorted(self.covered_alerts(), key=lambda record: record["number"]),
                "the stray is dismissed, so the first open listing does not carry it",
            )
            self.assertEqual(self.run_step(self.DISMISSED_LIST, env).returncode, 0)
            result = self.run_step(self.RECONCILE, env)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(self.stored(env, 900)["state"], "open")
            self.assertIsNone(self.stored(env, 900)["dismissed_reason"])
            listed = json.loads((Path(env["RUNNER_TEMP"]) / "alerts.json").read_text())
            self.assertIn(900, [record["number"] for record in listed])
            check = self.run_step(self.CHECK, env)
            self.assertNotEqual(check.returncode, 0, "the reopened alert must fail the run")
            self.assertIn("uncovered #900", check.stdout)

    def test_a_write_that_fails_leaves_state_a_later_run_converges_from(self):
        # Both interruption points. The step exits, so every later step of THAT
        # run is skipped and publication is blocked; a second, authorized run
        # over the state actually left behind converges without assuming the
        # first one finished.
        shipped = json.loads(DISPOSITIONS.read_text(encoding="utf-8"))[0]
        composed = f"{shipped['comment']}{cd.DISPOSITION_JOIN}{shipped['disposition']}"
        foreign = {"dismissed_reason": "used in tests", "dismissed_comment": "typed in the UI"}
        salt = self.covered_alerts()[0]
        for phase, left in (("open", "dismissed"), ("dismissed", "open")):
            with self.subTest(fails=phase), tempfile.TemporaryDirectory() as tmp:
                env = self.stage(
                    Path(tmp),
                    alerts=[self.covered_alerts()[1]],
                    dismissed_alerts=[{**salt, "state": "dismissed", **foreign}],
                )
                self.assertEqual(self.run_step(self.LIST, env).returncode, 0)
                self.assertEqual(self.run_step(self.DISMISSED_LIST, env).returncode, 0)
                first = self.run_step(self.RECONCILE, {**env, "STUB_PATCH_FAIL": phase})
                self.assertNotEqual(first.returncode, 0, "a refused write must stop the run")
                self.assertNotIn("reconcile reopened=", first.stdout, "no summary from a dead run")
                held = self.stored(env, 81)
                self.assertEqual(held["state"], left)
                if left == "dismissed":
                    # The reopen never landed: the record is exactly as it was.
                    self.assertEqual(held["dismissed_reason"], foreign["dismissed_reason"])
                    self.assertEqual(held["dismissed_comment"], foreign["dismissed_comment"])
                else:
                    # The reopen landed and the rewrite did not: open, unjustified.
                    self.assertIsNone(held["dismissed_reason"])
                    self.assertIsNone(held["dismissed_comment"])

                # A SECOND run, over that persisted state, with no memory of
                # the first. It re-lists, reconciles what is still dismissed,
                # checks coverage, and dismisses what reopening left open.
                for step in (self.LIST, self.DISMISSED_LIST, self.RECONCILE, self.CHECK):
                    with self.subTest(fails=phase, step=step):
                        again = self.run_step(step, env)
                        self.assertEqual(again.returncode, 0, again.stderr)
                dismiss = self.run_step(self.DISMISS, env)
                self.assertEqual(dismiss.returncode, 0, dismiss.stderr)
                self.assertIn("remaining=0", dismiss.stdout)
                converged = self.stored(env, 81)
                self.assertEqual(converged["state"], "dismissed")
                self.assertEqual(converged["dismissed_reason"], shipped["reason"])
                self.assertEqual(converged["dismissed_comment"], composed)

    def test_a_push_stops_and_names_the_alert_when_the_reopen_is_refused(self):
        salt = self.covered_alerts()[0]
        listing = [
            {
                **salt,
                "state": "dismissed",
                "dismissed_reason": "used in tests",
                "dismissed_comment": "typed in the UI",
            }
        ]
        with tempfile.TemporaryDirectory() as tmp:
            env = self.stage(Path(tmp), dismissed_alerts=listing)
            self.assertEqual(self.run_step(self.LIST, env).returncode, 0)
            self.assertEqual(self.run_step(self.DISMISSED_LIST, env).returncode, 0)
            result = self.run_step(self.RECONCILE, {**env, "STUB_GH_FAIL": "1"})
            self.assertNotEqual(result.returncode, 0, "a refused write must stop the run")
            self.assertIn("dispositions: redismiss alert=81 phase=reopen", result.stdout)
            self.assertNotIn("phase=dismiss", result.stdout)
            self.assertNotIn("reconcile reopened=", result.stdout)

    def test_a_push_counts_a_dismissal_whose_finding_is_gone_and_touches_nothing(self):
        # Both shapes GitHub uses to say the finding is no longer detected, run
        # through the real step: the instance it calls `fixed`, and the one it
        # leaves `dismissed` while stamping `fixed_at` on the alert -- which is
        # the shape 33 of main's 78 dismissals were in when the first live
        # reconcile refused the whole run (issue #29).
        for instance_state, stamp in (("fixed", None), ("dismissed", FIXED_AT)):
            with self.subTest(instance=instance_state, fixed_at=stamp):
                gone = {
                    **self.covered_alerts()[0],
                    "state": "dismissed",
                    "fixed_at": stamp,
                    "dismissed_reason": "false positive",
                    "dismissed_comment": "written before the code moved",
                }
                # The commit it was last seen on -- older than the one being
                # judged, by construction.
                gone["most_recent_instance"] = {
                    **gone["most_recent_instance"],
                    "state": instance_state,
                    "commit_sha": PREVIOUS_COMMIT,
                }
                with tempfile.TemporaryDirectory() as tmp:
                    env = self.stage(Path(tmp), dismissed_alerts=[gone])
                    self.assertEqual(self.run_step(self.LIST, env).returncode, 0)
                    self.assertEqual(self.run_step(self.DISMISSED_LIST, env).returncode, 0)
                    result = self.run_step(self.RECONCILE, env)
                    self.assertEqual(result.returncode, 0, result.stderr)
                    self.assertEqual(self.calls(env, "gh api -X PATCH"), [])
                    self.assertIn(
                        "dispositions: reconcile reopened=0 redismissed=0 unchanged=0 stale=1",
                        result.stdout,
                    )
                    self.assertIn("dispositions: stale alert=81", result.stdout)

    def test_the_base_check_validates_this_pull_requests_files_not_the_bases(self):
        # The staged base list is missing `cli/export.rs`, which a shipped
        # entry names. Validated against the base's list the run would refuse;
        # against this pull request's, it passes -- which is what a change that
        # adds a file and its disposition together needs.
        with tempfile.TemporaryDirectory() as tmp:
            env = self.stage(
                Path(tmp), event="pull_request", alerts=[], base_alerts=[self.base_alert()]
            )
            base_list = (Path(tmp) / "base-tracked.txt").read_text()
            self.assertNotIn("crates/obsyncd/src/cli/export.rs", base_list)
            for name in (self.LIST, self.BASE_LIST, self.BASE_TREE):
                self.assertEqual(self.run_step(name, env).returncode, 0)
            result = self.run_step(self.BASE_CHECK, env)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn("covered #40", result.stdout)

    def test_the_base_check_sees_a_dismissed_base_alert_this_file_stops_covering(self):
        # b5: an open-only base listing would miss exactly this -- the
        # acceptance main already relies on, deleted by the pull request.
        with tempfile.TemporaryDirectory() as tmp:
            env = self.stage(
                Path(tmp),
                event="pull_request",
                alerts=[],
                base_alerts=[],
                base_dismissed=[
                    self.base_alert(
                        line=1,
                        state="dismissed",
                        dismissed_reason="false positive",
                        dismissed_comment="an acceptance this pull request removes",
                    )
                ],
            )
            for name in (self.LIST, self.BASE_LIST, self.BASE_TREE):
                self.assertEqual(self.run_step(name, env).returncode, 0)
            self.assertEqual(
                len(json.loads((Path(env["RUNNER_TEMP"]) / "alerts-base.json").read_text())), 1
            )
            result = self.run_step(self.BASE_CHECK, env)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("uncovered #40", result.stdout)
            self.assertIn("the next push to main would reopen it", result.stdout)

    def test_the_base_listing_refuses_analyses_that_disagree(self):
        # b7: two legs on different commits means there is no single tree the
        # base's alert lines belong to.
        with tempfile.TemporaryDirectory() as tmp:
            env = self.stage(
                Path(tmp),
                event="pull_request",
                alerts=[],
                base_alerts=[],
                analyses=self.analyses((self.BASE_COMMIT, "c" * 40)),
            )
            result = self.run_step(self.BASE_LIST, env)
            self.assertNotEqual(result.returncode, 0, "disagreeing analyses must stop the job")
            self.assertIn("base analyses disagree", result.stderr)
            self.assertFalse((Path(env["RUNNER_TEMP"]) / "base-commit.txt").exists())

    def test_the_base_listing_refuses_a_branch_with_no_analysis(self):
        with tempfile.TemporaryDirectory() as tmp:
            env = self.stage(
                Path(tmp), event="pull_request", alerts=[], base_alerts=[], analyses=[]
            )
            result = self.run_step(self.BASE_LIST, env)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("has no CodeQL analysis for rust", result.stderr)

    def test_the_base_tree_is_fetched_at_the_analyses_commit(self):
        # b6, executed: the git calls name the commit, never the branch.
        with tempfile.TemporaryDirectory() as tmp:
            env = self.stage(
                Path(tmp), event="pull_request", alerts=[], base_alerts=[self.base_alert()]
            )
            self.assertEqual(self.run_step(self.BASE_LIST, env).returncode, 0)
            self.assertEqual(self.run_step(self.BASE_TREE, env).returncode, 0)
            self.assertEqual(
                self.calls(env, "git fetch"), [f"git fetch --depth=1 origin {self.BASE_COMMIT}"]
            )
            self.assertIn(
                f"git worktree add --detach {env['RUNNER_TEMP']}/base-tree {self.BASE_COMMIT}",
                self.calls(env, "git worktree"),
            )

    def test_the_base_steps_produce_nothing_on_a_push(self):
        with tempfile.TemporaryDirectory() as tmp:
            env = self.stage(Path(tmp))
            for name in (self.LIST, self.VALIDATE, self.CHECK, self.DISMISS):
                self.assertEqual(self.run_step(name, env).returncode, 0)
            temp = Path(env["RUNNER_TEMP"])
            for produced in ("alerts-base.json", "alerts-base-ref.txt", "base-tracked.txt"):
                with self.subTest(file=produced):
                    self.assertFalse((temp / produced).exists())
            self.assertEqual(self.calls(env, "git fetch"), [])
            self.assertEqual(self.calls(env, "git worktree"), [])

    def test_a_failing_api_call_stops_the_step(self):
        with tempfile.TemporaryDirectory() as tmp:
            env = self.stage(Path(tmp))
            for name in (self.WAIT, self.LIST):
                with self.subTest(step=name):
                    result = self.run_step(name, {**env, "STUB_GH_FAIL": "1"})
                    self.assertNotEqual(result.returncode, 0, "a failed API call must fail the step")


if __name__ == "__main__":
    unittest.main()
