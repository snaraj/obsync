#!/usr/bin/env python3
"""Reproduce the nonce-cache poison probes (#191, found by the arm64 runners).

Each probe must compile and fail a behavioral regression. Sources are restored
from their exact starting bytes in finally, including on failure or interrupt.
Never run beside another build or source editor in this worktree.
"""
from pathlib import Path
import subprocess

AUTH = "crates/obsyncd/src/api/auth.rs"
WOKEN = "a_member_woken_on_a_lock_a_flush_poisoned_is_answered"
CASES = [
    ("lock-trusts-poison", AUTH,
     'self.state.lock().unwrap_or_else(PoisonError::into_inner)\n    }',
     'self.state.lock().expect("nonce cache")\n    }', WOKEN),
    ("wait-trusts-poison", AUTH,
     "                    .wait(state)\n                    .unwrap_or_else(PoisonError::into_inner),",
     '                    .wait(state)\n                    .expect("nonce cache"),', WOKEN),
]


def main():
    originals = {Path(path): Path(path).read_bytes() for _, path, *_ in CASES}
    failures = []
    try:
        for name, path, old, new, selector in CASES:
            source = originals[Path(path)].decode()
            if source.count(old) != 1:
                raise RuntimeError(f"{name}: mutation context moved")
            Path(path).write_text(source.replace(old, new, 1))
            try:
                result = subprocess.run(
                    ["cargo", "test", "-p", "obsyncd", "--lib", selector],
                    stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                    text=True, timeout=300, check=False,
                )
                compiled = "could not compile" not in result.stdout
                killed = compiled and result.returncode != 0 and "FAILED" in result.stdout
                print(f"{name}: {'KILLED' if killed else 'NOT A KILL'}", flush=True)
                if not killed:
                    failures.append(name)
                    print(result.stdout, flush=True)
                else:
                    print("\n".join(line for line in result.stdout.splitlines()
                                    if "FAILED" in line or "test result:" in line), flush=True)
            finally:
                Path(path).write_bytes(originals[Path(path)])
    finally:
        for path, original in originals.items():
            path.write_bytes(original)
    if failures:
        raise SystemExit("Unkilled probes: " + ", ".join(failures))
    print(f"All {len(CASES)} server probes compiled and were killed.")


if __name__ == "__main__":
    main()
