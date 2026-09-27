#!/usr/bin/env python3
"""Reproduce the docs-ops lane's guard probes from the repository root.

Each probe replaces one exact source span, runs the named contract tests, and
must produce at least one assertion FAILURE (an error alone is not a kill).
Sources are restored from their exact starting bytes in finally, including on
failure or interrupt. Never run beside another editor in this worktree.
Arguments, if any, are name prefixes that select a subset (`observer-`).
"""
from pathlib import Path
import os
import subprocess
import sys

WORDING = "scripts/ci/test_folder_selection_wording.py"
WORDING_TESTS = ["-p", "test_folder_selection_wording.py"]
PINS = "scripts/ci/chart_pins.py"
PIN_TESTS = ["-p", "test_chart_pins.py"]
EXAMPLE = "chart/examples/static-local-volumes.yaml"
OBSERVER = "scripts/ci/release_contract.py"
OBSERVER_TESTS = ["-p", "test_release_contract.py", "-k", "TheLiveSettingsObserver"]
J7_FIXED = "its notes then sync, because saving the wider selection replays the history this device skipped, and every already-selected folder keeps every file"
J7_FALSE = "its notes then sync, or the plugin states in the UI why an expanded selection is refused. Either way every already-selected folder keeps every file"
GLOBS = 'for character in "*?[{\\\\")'
CASES = [
    ("wording-narrow-pattern", WORDING, '    re.compile(r"\\b(?:can|may|must|will)\\s+only\\s+(?:be\\s+)?narrow"),\n', "", WORDING_TESTS),
    ("wording-expansion-pattern", WORDING, '    re.compile(r"\\bexpan(?:sion|ds?|ded|ding)\\b[^.;]{0,80}?\\brefused\\b"),\n', "", WORDING_TESTS),
    ("wording-widening-pattern", WORDING, '    re.compile(r"\\bwiden(?:s|ed|ing)?\\b[^.;]{0,80}?\\b(?:is|are|was|were)\\s+refused\\b"),\n', "", WORDING_TESTS),
    ("wording-case-fold", WORDING, '"", text).lower()', '"", text)', WORDING_TESTS),
    ("wording-emphasis-fold", WORDING, 'prose = re.sub(r"[*_`]", "", text).lower()', "prose = text.lower()", WORDING_TESTS),
    ("wording-reads-docs", WORDING, '        *sorted((ROOT / "docs").rglob("*.md")),\n', "", WORDING_TESTS),
    ("wording-reads-plugin", WORDING, '        *sorted((ROOT / "plugin" / "src").rglob("*.ts")),\n', "", WORDING_TESTS),
    ("wording-j7-claim-returns", "docs/validation.md", J7_FIXED, J7_FALSE, WORDING_TESTS),
    ("wording-settings-row-claim", "plugin/src/ui/settings.ts", "other devices cannot widen this.", "the selection can only narrow once this device has synced.", WORDING_TESTS),
    ("example-pin-dropped", PINS, '    equals(\n        sorted(volume["spec"]["claimRef"]["name"] for volume in every(example, "PersistentVolume")),\n        sorted(known),\n        f"the claims {STATIC_VOLUME_EXAMPLE} pre-binds",\n    )\n', "", PIN_TESTS),
    ("example-claim-renamed", EXAMPLE, "    name: obsync-journal\n", "    name: obsidian-journal\n", PIN_TESTS),
    ("example-provisioner", EXAMPLE, "provisioner: kubernetes.io/no-provisioner", "provisioner: rancher.io/local-path", PIN_TESTS),
    ("example-binding-mode", EXAMPLE, "volumeBindingMode: WaitForFirstConsumer", "volumeBindingMode: Immediate", PIN_TESTS),
    ("example-class-reclaim", EXAMPLE, "reclaimPolicy: Retain\n---", "reclaimPolicy: Delete\n---", PIN_TESTS),
    ("example-volume-reclaim", EXAMPLE, "  persistentVolumeReclaimPolicy: Retain\n  storageClassName: obsync-local\n  claimRef:\n    namespace: obsidian\n    name: obsync-blobs", "  persistentVolumeReclaimPolicy: Delete\n  storageClassName: obsync-local\n  claimRef:\n    namespace: obsidian\n    name: obsync-blobs", PIN_TESTS),
    ("example-volume-class", EXAMPLE, "  storageClassName: obsync-local\n  claimRef:\n    namespace: obsidian\n    name: obsync-journal", "  storageClassName: local-pie-ssd\n  claimRef:\n    namespace: obsidian\n    name: obsync-journal", PIN_TESTS),
    ("example-capacity", EXAMPLE, "storage: 250Gi", "storage: 200Gi", PIN_TESTS),
    ("example-access-mode", EXAMPLE, "  accessModes:\n    - ReadWriteOnce\n  persistentVolumeReclaimPolicy: Retain\n  storageClassName: obsync-local\n  claimRef:\n    namespace: obsidian\n    name: obsync-journal", "  accessModes:\n    - ReadWriteMany\n  persistentVolumeReclaimPolicy: Retain\n  storageClassName: obsync-local\n  claimRef:\n    namespace: obsidian\n    name: obsync-journal", PIN_TESTS),
    ("example-local-path", EXAMPLE, "path: <BLOBS_PATH>", "path: /var/lib/obsync/blobs", PIN_TESTS),
    ("example-node-affinity", EXAMPLE, "    path: <JOURNAL_PATH>\n  nodeAffinity:\n    required:\n      nodeSelectorTerms:\n        - matchExpressions:\n            - key: kubernetes.io/hostname\n              operator: In\n              values:\n                - <NODE_NAME>", "    path: <JOURNAL_PATH>\n  nodeAffinity:\n    required:\n      nodeSelectorTerms:\n        - matchExpressions:\n            - key: kubernetes.io/hostname\n              operator: In\n              values:\n                - sync-node", PIN_TESTS),
    ("example-directory-mode", EXAMPLE, "#   install -d -o 65532 -g 65532 -m 0700 <JOURNAL_PATH>", "#   install -d -o 65532 -g 65532 -m 0750 <JOURNAL_PATH>", PIN_TESTS),
    ("observer-issue-43-regression", OBSERVER, "    core = []\n", '    if [s.get("enforcement") for s in summaries].count("active") != 1:\n        raise ContractError("expected exactly one active repository ruleset")\n    core = []\n', OBSERVER_TESTS),
    ("observer-default-branch", OBSERVER, '    if repository_record.get("default_branch") != "main":\n        raise ContractError("the default branch is not main")\n', "", OBSERVER_TESTS),
    ("observer-id-is-a-number", OBSERVER, "isinstance(ruleset_id, int) and not isinstance(ruleset_id, bool)", "True", OBSERVER_TESTS),
    ("observer-id-is-not-a-boolean", OBSERVER, "isinstance(ruleset_id, int) and not isinstance(ruleset_id, bool)", "isinstance(ruleset_id, int)", OBSERVER_TESTS),
    ("observer-id-is-unique", OBSERVER, " or len(set(ids)) != len(ids):", ":", OBSERVER_TESTS),
    ("observer-branch-target-only", OBSERVER, 'if summary.get("target") != "branch" or summary.get("enforcement") != "active":', 'if summary.get("enforcement") != "active":', OBSERVER_TESTS),
    ("observer-active-only", OBSERVER, 'if summary.get("target") != "branch" or summary.get("enforcement") != "active":', 'if summary.get("target") != "branch":', OBSERVER_TESTS),
    ("observer-read-id-matches", OBSERVER, 'for field in ("id", "target", "enforcement")):', 'for field in ("target", "enforcement")):', OBSERVER_TESTS),
    ("observer-read-target-matches", OBSERVER, 'for field in ("id", "target", "enforcement")):', 'for field in ("id", "enforcement")):', OBSERVER_TESTS),
    ("observer-read-enforcement-matches", OBSERVER, 'for field in ("id", "target", "enforcement")):', 'for field in ("id", "target")):', OBSERVER_TESTS),
    ("observer-one-condition", OBSERVER, 'if set(conditions) != {"ref_name"} or set(ref_name) != {"include", "exclude"}:', 'if set(ref_name) != {"include", "exclude"}:', OBSERVER_TESTS),
    ("observer-condition-keys", OBSERVER, 'if set(conditions) != {"ref_name"} or set(ref_name) != {"include", "exclude"}:', 'if set(conditions) != {"ref_name"}:', OBSERVER_TESTS),
    ("observer-pattern-strings", OBSERVER, '    if not all(isinstance(pattern, str) for pattern in include + exclude):\n        raise ContractError("ruleset ref_name patterns must be strings")\n', "", OBSERVER_TESTS),
    ("observer-exact-inclusion", OBSERVER, "bool(MAIN_TARGETS.intersection(include))", "bool(include)", OBSERVER_TESTS),
    ("observer-default-branch-token", OBSERVER, 'MAIN_TARGETS = frozenset({MAIN_REF, "~DEFAULT_BRANCH", "~ALL"})', 'MAIN_TARGETS = frozenset({MAIN_REF, "~ALL"})', OBSERVER_TESTS),
    ("observer-all-branches-token", OBSERVER, 'MAIN_TARGETS = frozenset({MAIN_REF, "~DEFAULT_BRANCH", "~ALL"})', 'MAIN_TARGETS = frozenset({MAIN_REF, "~DEFAULT_BRANCH"})', OBSERVER_TESTS),
    ("observer-excluded-token", OBSERVER, '        pattern.startswith("~")\n        or pattern.casefold() == MAIN_REF', "        pattern.casefold() == MAIN_REF", OBSERVER_TESTS),
    ("observer-excluded-main", OBSERVER, "        or pattern.casefold() == MAIN_REF\n", "", OBSERVER_TESTS),
    ("observer-excluded-main-any-case", OBSERVER, "pattern.casefold() == MAIN_REF", "pattern == MAIN_REF", OBSERVER_TESTS),
    ("observer-excluded-star", OBSERVER, GLOBS, GLOBS.replace("*", ""), OBSERVER_TESTS),
    ("observer-excluded-question", OBSERVER, GLOBS, GLOBS.replace("?", ""), OBSERVER_TESTS),
    ("observer-excluded-bracket", OBSERVER, GLOBS, GLOBS.replace("[", ""), OBSERVER_TESTS),
    ("observer-excluded-brace", OBSERVER, GLOBS, GLOBS.replace("{", ""), OBSERVER_TESTS),
    ("observer-excluded-escape", OBSERVER, GLOBS, GLOBS.replace("\\\\", ""), OBSERVER_TESTS),
    ("observer-no-bypass-actor", OBSERVER, 'return not actors and ruleset.get("current_user_can_bypass") == "never"', 'return ruleset.get("current_user_can_bypass") == "never"', OBSERVER_TESTS),
    ("observer-caller-cannot-bypass", OBSERVER, 'return not actors and ruleset.get("current_user_can_bypass") == "never"', "return not actors", OBSERVER_TESTS),
    ("observer-bypass-list-readable", OBSERVER, 'actors = _array(ruleset.get("bypass_actors"), "ruleset bypass actors")', 'actors = ruleset.get("bypass_actors") or []', OBSERVER_TESTS),
    ("observer-core-required", OBSERVER, "    if not core:\n        raise ContractError(", "    if False:\n        raise ContractError(", OBSERVER_TESTS),
    ("observer-parameters-unambiguous", OBSERVER, "if types.count(rule_type) > 1:", "if types.count(rule_type) > 2:", OBSERVER_TESTS),
    ("observer-core-only", OBSERVER, "if _names_main(ruleset) and _bypassed_by_nobody(ruleset):", "if _names_main(ruleset) or _bypassed_by_nobody(ruleset):", OBSERVER_TESTS),
]


def main():
    selected = [case for case in CASES if not sys.argv[1:] or case[0].startswith(tuple(sys.argv[1:]))]
    originals = {Path(path): Path(path).read_bytes() for _, path, *_ in selected}
    failures = []
    try:
        for name, path, old, new, tests in selected:
            source = originals[Path(path)].decode()
            if source.count(old) != 1:
                raise RuntimeError(f"{name}: mutation context moved")
            Path(path).write_text(source.replace(old, new, 1))
            try:
                result = subprocess.run(
                    ["python3", "-B", "-m", "unittest", "discover", "-s", "scripts/ci", *tests],
                    stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                    text=True, timeout=600, check=False, env={**os.environ, "PYTHON_COLORS": "0"},
                )
                summary = next((line for line in result.stdout.splitlines()
                                if line.startswith(("OK", "FAILED ("))), "no unittest summary")
                killed = result.returncode != 0 and "failures=" in summary
                failed = sorted({line.split(" (")[0] for line in result.stdout.splitlines()
                                 if line.startswith("FAIL: ")})
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
    print(f"All {len(selected)} probes were killed by an assertion failure.")


if __name__ == "__main__":
    main()
