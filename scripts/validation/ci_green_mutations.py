#!/usr/bin/env python3
"""Reproduce the nonce-cache poison probes (#191, found by the arm64 runners).

Each probe must compile and fail a behavioral regression. Sources are restored
from their exact starting bytes in finally, including on failure or interrupt.
Never run beside another build or source editor in this worktree.
"""
from pathlib import Path

from kills import Judge

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
    judge = Judge({("obsyncd", case[-1]) for case in CASES})
    try:
        for name, path, old, new, selector in CASES:
            source = originals[Path(path)].decode()
            if source.count(old) != 1:
                raise RuntimeError(f"{name}: mutation context moved")
            Path(path).write_text(source.replace(old, new, 1))
            try:
                verdict, evidence = judge.test(selector)
                print(f"{name}: {verdict}\n{evidence}", flush=True)
                if verdict != "KILLED":
                    failures.append(f"{name} ({verdict})")
            finally:
                Path(path).write_bytes(originals[Path(path)])
    finally:
        for path, original in originals.items():
            path.write_bytes(original)
        judge.close()
    if failures:
        raise SystemExit("Unkilled probes: " + ", ".join(failures))
    print(f"All {len(CASES)} server probes compiled and were killed.")


if __name__ == "__main__":
    main()
