#!/usr/bin/env python3
"""Reproduce the docs-ops lane's guard probes from the repository root.

Each probe replaces one exact source span, runs the named contract test module,
and must produce at least one assertion FAILURE (an error alone is not a kill).
Sources are restored from their exact starting bytes in finally, including on
failure or interrupt. Never run beside another editor in this worktree.
"""
from pathlib import Path
import os
import subprocess

WORDING = "scripts/ci/test_folder_selection_wording.py"
J7_FIXED = "its notes then sync, because saving the wider selection replays the history this device skipped, and every already-selected folder keeps every file"
J7_FALSE = "its notes then sync, or the plugin states in the UI why an expanded selection is refused. Either way every already-selected folder keeps every file"
CASES = [
    ("wording-narrow-pattern", WORDING, '    re.compile(r"\\b(?:can|may|must|will)\\s+only\\s+(?:be\\s+)?narrow"),\n', "", "test_folder_selection_wording"),
    ("wording-expansion-pattern", WORDING, '    re.compile(r"\\bexpan(?:sion|ds?|ded|ding)\\b[^.;]{0,80}?\\brefused\\b"),\n', "", "test_folder_selection_wording"),
    ("wording-widening-pattern", WORDING, '    re.compile(r"\\bwiden(?:s|ed|ing)?\\b[^.;]{0,80}?\\b(?:is|are|was|were)\\s+refused\\b"),\n', "", "test_folder_selection_wording"),
    ("wording-case-fold", WORDING, '"", text).lower()', '"", text)', "test_folder_selection_wording"),
    ("wording-emphasis-fold", WORDING, 'prose = re.sub(r"[*_`]", "", text).lower()', "prose = text.lower()", "test_folder_selection_wording"),
    ("wording-reads-docs", WORDING, '        *sorted((ROOT / "docs").rglob("*.md")),\n', "", "test_folder_selection_wording"),
    ("wording-reads-plugin", WORDING, '        *sorted((ROOT / "plugin" / "src").rglob("*.ts")),\n', "", "test_folder_selection_wording"),
    ("wording-j7-claim-returns", "docs/validation.md", J7_FIXED, J7_FALSE, "test_folder_selection_wording"),
    ("wording-settings-row-claim", "plugin/src/ui/settings.ts", "other devices cannot widen this.", "the selection can only narrow once this device has synced.", "test_folder_selection_wording"),
]


def main():
    originals = {Path(path): Path(path).read_bytes() for _, path, *_ in CASES}
    failures = []
    try:
        for name, path, old, new, module in CASES:
            source = originals[Path(path)].decode()
            if source.count(old) != 1:
                raise RuntimeError(f"{name}: mutation context moved")
            Path(path).write_text(source.replace(old, new, 1))
            try:
                result = subprocess.run(
                    ["python3", "-B", "-m", "unittest", module],
                    cwd="scripts/ci", stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                    text=True, timeout=600, check=False, env={**os.environ, "PYTHON_COLORS": "0"},
                )
                summary = result.stdout.strip().splitlines()[-1] if result.stdout.strip() else ""
                killed = result.returncode != 0 and "failures=" in summary
                failed = [line for line in result.stdout.splitlines() if line.startswith("FAIL: ")]
                print(f"{name}: {'KILLED' if killed else 'NOT A KILL'} {summary}", flush=True)
                print("\n".join(f"  {line}" for line in failed), flush=True)
                if not killed:
                    failures.append(name)
                    print(result.stdout, flush=True)
            finally:
                Path(path).write_bytes(originals[Path(path)])
    finally:
        for path, original in originals.items():
            path.write_bytes(original)
    if failures:
        raise SystemExit("Unkilled probes: " + ", ".join(failures))
    print(f"All {len(CASES)} probes were killed by an assertion failure.")


if __name__ == "__main__":
    main()
