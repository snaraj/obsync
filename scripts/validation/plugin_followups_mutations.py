#!/usr/bin/env python3
"""Reproduce the 1.1.4 plugin-followups lane's dashboard probes from the repository root.

The dashboard marks a device still pairing (issue #152) and lists the paired,
then the pairing, then the revoked (the desktop rig, 2026-09-26). Each probe
removes one of those guards and must fail an assertion of
`node --test dashboard/test/*.test.mjs`. Sources are restored from their exact
starting bytes in finally, including on failure or interrupt. Never run beside
another editor of dashboard/ in this worktree.
"""
from pathlib import Path
import subprocess

LIB = "dashboard/lib.js"
APP = "dashboard/app.js"
CASES = [
    ("pending-marked", LIB, "pending: d.state === 'pending',", "pending: false,"),
    ("pending-shown", APP, "field(node, 'pending').hidden = !row.pending;", "field(node, 'pending').hidden = true;"),
    ("pending-after-paired", LIB, "const rank = (row) => (row.revoked ? 2 : row.pending ? 1 : 0);",
     "const rank = (row) => (row.revoked ? 2 : 0);"),
    ("revoked-last", LIB, "const rank = (row) => (row.revoked ? 2 : row.pending ? 1 : 0);",
     "const rank = (row) => (row.pending ? 1 : 0);"),
]


def main():
    originals = {Path(path): Path(path).read_bytes() for _, path, *_ in CASES}
    failures = []
    try:
        for name, path, old, new in CASES:
            source = originals[Path(path)].decode()
            if source.count(old) != 1:
                raise RuntimeError(f"{name}: mutation context moved")
            Path(path).write_text(source.replace(old, new, 1))
            try:
                tests = sorted(str(p) for p in Path("dashboard/test").glob("*.test.mjs"))
                result = subprocess.run(
                    ["node", "--test", *tests],
                    stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                    text=True, timeout=120, check=False,
                )
                killed = result.returncode != 0 and "AssertionError" in result.stdout
                print(f"{name}: {'KILLED' if killed else 'NOT A KILL'}", flush=True)
                if not killed:
                    failures.append(name)
                    print(result.stdout, flush=True)
                else:
                    print("\n".join(line for line in result.stdout.splitlines()
                                    if line.lstrip().startswith("✖") or "# fail" in line or "ℹ fail" in line), flush=True)
            finally:
                Path(path).write_bytes(originals[Path(path)])
    finally:
        for path, original in originals.items():
            path.write_bytes(original)
    if failures:
        raise SystemExit("Unkilled probes: " + ", ".join(failures))
    print(f"All {len(CASES)} dashboard probes were killed.")


if __name__ == "__main__":
    main()
