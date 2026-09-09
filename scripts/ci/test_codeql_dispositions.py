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


def entry(**overrides: object) -> dict:
    """One well-formed entry, with `_ABSENT` removing a field."""
    record: dict[str, object] = {
        "rule": CRYPTO_RULE,
        "path": "crates/obsyncd/src/storage/mod.rs",
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
) -> dict:
    return {
        "number": number,
        "state": state,
        "rule": {"id": rule, "severity": "warning"},
        "most_recent_instance": {
            "ref": ref,
            "analysis_key": ".github/workflows/codeql.yml:analyze",
            "location": {"path": path, "start_line": line, "end_line": line},
        },
    }


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
            entry(path="crates/**/*.rs", line_contains="WRAP_SALT", within="test-module"),
            "carries line_contains and within",
        )

    def test_a_short_or_untrimmed_line_token_is_refused(self):
        self.refuse(entry(line_contains="key"), "at least 4 characters")
        self.refuse(entry(line_contains="WRAP_SALT "), "not a trimmed token")

    def test_an_unmodelled_within_value_is_refused(self):
        self.refuse(entry(within="tests"), "field within must be one of test-module")

    def test_within_test_module_over_a_non_rust_path_is_refused(self):
        self.refuse(
            entry(path="plugin/test/**", within="test-module", reason="used in tests"),
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
                cd.load_entries([entry(reason="used in tests", **overrides)], TRACKED)

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
        return cd.covers(loaded, cd.load_alerts([hit], hit["most_recent_instance"]["ref"])[0], self.tree)

    def test_line_contains_reads_the_flagged_line(self):
        self.assertTrue(self.covers(entry(line_contains="WRAP_SALT"), alert(line=2)))
        for line in (1, 3, 4, 8):
            with self.subTest(line=line):
                self.assertFalse(self.covers(entry(line_contains="WRAP_SALT"), alert(line=line)))

    def test_line_contains_refuses_a_line_past_the_end_of_the_file(self):
        self.assertFalse(self.covers(entry(line_contains="WRAP_SALT"), alert(line=9999)))

    def test_line_contains_refuses_a_file_that_is_not_there(self):
        self.assertFalse(
            self.covers(
                entry(path="crates/**/*.rs", line_contains="WRAP_SALT"),
                alert(path="crates/obsyncd/src/api/auth.rs", line=2),
            )
        )

    def test_within_test_module_accepts_at_or_after_the_marker_and_refuses_above_it(self):
        scoped = entry(path="crates/**/*.rs", within="test-module", reason="used in tests")
        for line in (6, 7, 8, 9):
            with self.subTest(line=line):
                self.assertTrue(self.covers(scoped, alert(line=line)))
        for line in (1, 2, 3, 4, 5):
            with self.subTest(line=line):
                self.assertFalse(self.covers(scoped, alert(line=line)))

    def test_within_test_module_refuses_a_file_with_no_marker(self):
        (self.root / "crates/obsyncd/src/api").mkdir(parents=True)
        (self.root / "crates/obsyncd/src/api/auth.rs").write_text("fn a() {}\n", encoding="utf-8")
        scoped = entry(path="crates/**/*.rs", within="test-module", reason="used in tests")
        self.assertFalse(self.covers(scoped, alert(path="crates/obsyncd/src/api/auth.rs", line=1)))

    def test_an_unscoped_entry_covers_by_rule_and_path_alone(self):
        unscoped = entry(path="plugin/test/**", rule=URL_RULE, reason="used in tests")
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
                    cd.load_alerts([alert(path=path)], cd.MAIN_REF)
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
                [entry(path="crates/**/*.rs", within="test-module", reason="used in tests")],
                TRACKED,
            )[0]

            def covered(line: int) -> bool:
                hit = cd.load_alerts(
                    [alert(path="crates/obsyncd/src/api/auth.rs", line=line)], cd.MAIN_REF
                )[0]
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
                [entry(path="crates/**/*.rs", within="test-module", reason="used in tests")],
                TRACKED,
            )[0]
            for line in (1, 2, 4):
                with self.subTest(line=line):
                    hit = cd.load_alerts(
                        [alert(path="crates/obsyncd/src/api/auth.rs", line=line)], cd.MAIN_REF
                    )[0]
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

    def check(self, entries: list[dict], alerts: list[dict], ref: str = cd.MAIN_REF):
        dispositions, listing = self.files(entries, alerts)
        return run_cli(
            [
                "check",
                "--dispositions", dispositions,
                "--alerts", listing,
                "--tree", str(self.root / "tree"),
                "--tracked", str(self.tracked),
                "--ref", ref,
            ]
        )

    def plan(self, entries: list[dict], alerts: list[dict]):
        dispositions, listing = self.files(entries, alerts)
        return run_cli(
            [
                "plan",
                "--dispositions", dispositions,
                "--alerts", listing,
                "--tree", str(self.root / "tree"),
                "--tracked", str(self.tracked),
            ]
        )

    def test_validate_accepts_a_good_file_and_names_every_entry(self):
        dispositions, _ = self.files([entry(line_contains="WRAP_SALT")], [])
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
        code, out, _ = self.check([entry(line_contains="WRAP_SALT")], [alert(number=81, line=2)])
        self.assertEqual(code, 0)
        self.assertIn(
            "covered #81 rust/hard-coded-cryptographic-value "
            "crates/obsyncd/src/storage/mod.rs:2 entry=0",
            out,
        )
        self.assertIn("uncovered=0 stale=0 decision=pass", out)

    def test_check_exits_1_and_names_every_uncovered_alert(self):
        code, out, err = self.check(
            [entry(line_contains="WRAP_SALT")],
            [alert(number=81, line=2), alert(number=90, line=4), alert(number=91, line=1)],
        )
        self.assertEqual(code, 1)
        self.assertIn("uncovered #90 rust/hard-coded-cryptographic-value", out)
        self.assertIn("crates/obsyncd/src/storage/mod.rs:4", out)
        self.assertIn("uncovered #91", out)
        self.assertIn("uncovered=2 stale=0 decision=refuse", out)
        self.assertIn("2 open alert(s) no reviewed disposition covers", err)

    def test_check_reports_an_entry_that_matched_nothing(self):
        code, out, _ = self.check(
            [entry(line_contains="WRAP_SALT"), entry(rule=LOGGING_RULE, path="crates/**/*.rs")],
            [alert(number=81, line=2)],
        )
        self.assertEqual(code, 0)
        self.assertIn("stale entry=1 rule=rust/cleartext-logging path=crates/**/*.rs", out)
        self.assertNotIn("stale entry=0", out)
        self.assertIn("stale=1", out)

    def test_check_refuses_an_alert_analysed_on_another_ref(self):
        code, _, err = self.check(
            [entry(line_contains="WRAP_SALT")], [alert(number=81, line=2, ref=PR_REF)]
        )
        self.assertEqual(code, 1)
        self.assertIn(f"alert #81 was analysed on {PR_REF}, not {cd.MAIN_REF}", err)

    def test_check_reads_the_pull_request_ref_when_that_is_what_was_analysed(self):
        code, _, _ = self.check(
            [entry(line_contains="WRAP_SALT")], [alert(number=81, line=2, ref=PR_REF)], ref=PR_REF
        )
        self.assertEqual(code, 0)

    def test_check_refuses_an_alert_that_is_not_open(self):
        for state in ("dismissed", "fixed", "closed", None):
            with self.subTest(state=state):
                code, _, err = self.check(
                    [entry(line_contains="WRAP_SALT")], [alert(number=81, line=2, state=state)]
                )
                self.assertEqual(code, 1)
                self.assertIn("open alerts only", err)

    def test_check_refuses_a_malformed_alert(self):
        good = alert(number=81, line=2)
        for mutation, expected in (
            ({"number": 0}, "no positive alert number"),
            ({"rule": {}}, "no readable rule id"),
            ({"most_recent_instance": {}}, "names no analysed ref"),
            ({"most_recent_instance": {"ref": cd.MAIN_REF}}, "location is not an object"),
        ):
            with self.subTest(mutation=sorted(mutation)):
                code, _, err = self.check([entry(line_contains="WRAP_SALT")], [{**good, **mutation}])
                self.assertEqual(code, 1)
                self.assertIn(expected, err)
        code, _, err = self.check([entry(line_contains="WRAP_SALT")], [{"number": 1}])
        self.assertEqual(code, 1)

    def test_plan_emits_exactly_the_covered_alerts_with_their_dismissal_fields(self):
        entries = [
            entry(line_contains="WRAP_SALT"),
            entry(path="plugin/test/**", rule=URL_RULE, reason="used in tests",
                  comment="a string constant in a test bundle"),
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
            [entry(line_contains="WRAP_SALT")], [alert(number=81, line=2, ref=PR_REF)]
        )
        self.assertEqual(code, 1)
        self.assertEqual(out, "")
        self.assertIn(f"was analysed on {PR_REF}, not {cd.MAIN_REF}", err)

    def test_plan_is_empty_and_successful_when_main_holds_no_open_alert(self):
        code, out, _ = self.plan([entry(line_contains="WRAP_SALT")], [])
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
        hit = cd.load_alerts(
            [alert(number=81, path="crates/obsyncd/src/storage/mod.rs", line=declared[0])],
            cd.MAIN_REF,
        )[0]
        covering = [e for e in self.entries if cd.covers(e, hit, self.tree)]
        self.assertEqual([e.reason for e in covering[:1]], ["false positive"])
        self.assertTrue(covering[0].disposition.endswith("/20"))

    def test_the_test_vector_disposition_covers_a_line_inside_a_test_module_only(self):
        source = (ROOT / "crates/obsyncd/src/api/auth.rs").read_text(encoding="utf-8")
        marker = cd.test_module_line(source.splitlines())
        self.assertIsNotNone(marker)
        inside = cd.load_alerts(
            [alert(number=1, path="crates/obsyncd/src/api/auth.rs", line=marker + 1)], cd.MAIN_REF
        )[0]
        above = cd.load_alerts(
            [alert(number=2, path="crates/obsyncd/src/api/auth.rs", line=marker - 1)], cd.MAIN_REF
        )[0]
        self.assertTrue(any(cd.covers(e, inside, self.tree) for e in self.entries))
        self.assertFalse(any(cd.covers(e, above, self.tree) for e in self.entries))

    def test_the_whole_file_test_module_disposition_covers_the_dedicated_test_file(self):
        # crates/obsyncd/src/api/server_test.rs carries NO `#[cfg(test)]` line
        # of its own -- its parent declares it as `#[cfg(test)] mod
        # server_test;` -- so the test-module scope cannot reach it and the
        # test-location entry is what covers alert #32.
        path = "crates/obsyncd/src/api/server_test.rs"
        self.assertIsNone(cd.test_module_line((ROOT / path).read_text(encoding="utf-8").splitlines()))
        hit = cd.load_alerts([alert(number=32, path=path, line=1)], cd.MAIN_REF)[0]
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
                hit = cd.load_alerts([alert(rule=rule, path=path, line=line)], cd.MAIN_REF)[0]
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
                hit = cd.load_alerts([alert(rule=LOGGING_RULE, path=path, line=1)], cd.MAIN_REF)[0]
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

    def test_only_the_dismissal_carries_a_guard(self):
        guarded = [name for name, step in zip(self.names, self.steps) if "if" in step]
        self.assertEqual(guarded, ["Dismiss every covered alert and require main to hold none"])

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
# Stand-in for the three gh shapes this job uses: read a SARIF's processing
# status, list open alerts, and PATCH one alert to dismissed.
printf 'gh %s\n' "$*" >> "${STUB_LOG}"
[ -n "${STUB_GH_FAIL:-}" ] && exit 4
patch=0
target=""
filter=""
previous=""
for argument in "$@"; do
  case "${argument}" in
    PATCH) patch=1 ;;
    repos/*) target="${argument}" ;;
  esac
  [ "${previous}" = "--jq" ] && filter="${argument}"
  previous="${argument}"
done
if [ "${patch}" -eq 1 ]; then exit 0; fi
case "${target}" in
  *code-scanning/sarifs/*)
    status="$(head -n 1 "${STUB_SARIF_STATUS}")"
    tail -n +2 "${STUB_SARIF_STATUS}" > "${STUB_SARIF_STATUS}.rest"
    [ -s "${STUB_SARIF_STATUS}.rest" ] && mv "${STUB_SARIF_STATUS}.rest" "${STUB_SARIF_STATUS}"
    rm -f "${STUB_SARIF_STATUS}.rest"
    printf '%s\n' "${status}" ;;
  *code-scanning/alerts*)
    if [ "${filter}" = ".[]" ]; then cat "${STUB_ALERTS}"; else cat "${STUB_REMAINING}"; fi ;;
  *) echo "unexpected gh call: $*" >&2; exit 64 ;;
esac
"""

SLEEP_STUB = r"""#!/bin/sh
# The poll interval, recorded rather than waited out.
printf 'sleep %s\n' "$*" >> "${STUB_LOG}"
exit 0
"""


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

    def covered_alerts(self) -> list[dict]:
        return [
            alert(number=81, path="crates/obsyncd/src/storage/mod.rs", line=self.salt_line),
            alert(number=80, rule=URL_RULE, path="plugin/test/bundle.test.mjs", line=103),
        ]

    def stage(
        self,
        root: Path,
        *,
        event: str = "push",
        statuses: tuple[str, ...] = ("complete",),
        alerts: list[dict] | None = None,
        remaining: str = "",
    ) -> dict:
        bins, temp = root / "bin", root / "runner-temp"
        bins.mkdir()
        temp.mkdir()
        for name, body in (("gh", GH_STUB), ("sleep", SLEEP_STUB)):
            path = bins / name
            path.write_text(body)
            path.chmod(0o755)
        (root / "sarif-status").write_text("\n".join(statuses) + "\n")
        (root / "alerts.jsonl").write_text(
            "".join(json.dumps(a) + "\n" for a in (self.covered_alerts() if alerts is None else alerts))
        )
        (root / "remaining").write_text(remaining)
        return {
            "PATH": f"{bins}{os.pathsep}{os.environ['PATH']}",
            "HOME": str(root),
            "LANG": "C",
            "RUNNER_TEMP": str(temp),
            "GITHUB_REPOSITORY": "snaraj/obsync",
            "GITHUB_EVENT_NAME": event,
            "PR_NUMBER": "23" if event == "pull_request" else "",
            "SARIF_ID_RUST": "sarif-rust",
            "SARIF_ID_JAVASCRIPT_TYPESCRIPT": "sarif-js",
            "STUB_LOG": str(root / "calls.log"),
            "STUB_SARIF_STATUS": str(root / "sarif-status"),
            "STUB_ALERTS": str(root / "alerts.jsonl"),
            "STUB_REMAINING": str(root / "remaining"),
        }

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
    VALIDATE = "Validate the disposition file"
    CHECK = "Refuse any open alert no disposition covers"
    DISMISS = "Dismiss every covered alert and require main to hold none"

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
            self.assertEqual(json.loads((temp / "alerts.json").read_text()), self.covered_alerts())
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
                alert(number=900, rule=LOGGING_RULE, path="crates/obsyncd/src/log.rs", line=1)
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
            patches = self.calls(env, "gh api -X PATCH")
            self.assertEqual(len(patches), 2)
            self.assertIn(
                "gh api -X PATCH repos/snaraj/obsync/code-scanning/alerts/81 -f state=dismissed "
                "-f dismissed_reason=false positive -f dismissed_comment=HKDF domain-separation",
                patches[0],
            )
            self.assertIn("Disposition: https://github.com/snaraj/obsync/issues/20", patches[0])
            self.assertIn("alerts/80 -f state=dismissed -f dismissed_reason=used in tests", patches[1])
            self.assertIn("Disposition: https://github.com/snaraj/obsync/issues/22", patches[1])
            self.assertIn("dismissed=2 remaining=0", result.stdout)

    def test_a_push_fails_when_main_still_holds_an_open_alert_afterwards(self):
        with tempfile.TemporaryDirectory() as tmp:
            env = self.stage(Path(tmp), remaining="#900 rust/cleartext-logging cli/check.rs:52\n")
            self.assertEqual(self.run_step(self.LIST, env).returncode, 0)
            result = self.run_step(self.DISMISS, env)
            self.assertNotEqual(result.returncode, 0, "a remaining open alert must fail the job")
            self.assertIn("main still holds open code-scanning alerts", result.stderr)
            self.assertIn("#900 rust/cleartext-logging", result.stderr)

    def test_a_pull_request_writes_nothing(self):
        with tempfile.TemporaryDirectory() as tmp:
            env = self.stage(Path(tmp), event="pull_request", alerts=[])
            for name in (self.WAIT, self.LIST, self.VALIDATE, self.CHECK):
                with self.subTest(step=name):
                    self.assertEqual(self.run_step(name, env).returncode, 0)
            self.assertEqual(self.calls(env, "gh api -X PATCH"), [])
            self.assertIsNone(
                self.steps[self.CHECK].get("if"), "the check must not be guarded off a pull request"
            )
            self.assertIn("github.event_name == 'push'", self.steps[self.DISMISS]["if"])

    def test_a_failing_api_call_stops_the_step(self):
        with tempfile.TemporaryDirectory() as tmp:
            env = self.stage(Path(tmp))
            for name in (self.WAIT, self.LIST):
                with self.subTest(step=name):
                    result = self.run_step(name, {**env, "STUB_GH_FAIL": "1"})
                    self.assertNotEqual(result.returncode, 0, "a failed API call must fail the step")


if __name__ == "__main__":
    unittest.main()
