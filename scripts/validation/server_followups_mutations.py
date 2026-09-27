#!/usr/bin/env python3
"""Reproduce the 1.1.4 server follow-up guard probes from the repository root.

Each probe breaks one guard of #214 (repeated forwarding fields are one list,
walked from the right, and said once a minute). It must compile and fail a
behavioral test. Sources are restored from their exact starting bytes in
finally, including on failure or interrupt. Never run beside another build or
source editor in this worktree.
"""
from pathlib import Path
import subprocess

EDGE = "crates/obsyncd/src/api/edge.rs"
API = "crates/obsyncd/src/api/mod.rs"
NAMES = "a_trusted_proxy_names_the_client"
JOINED = "said_once_a_minute"
CASES = [
    # First field wins again, header by header and in the list itself.
    ("xff-every-field", EDGE, "forwarded_for: req.headers.all(FORWARDED_FOR),",
     "forwarded_for: req.headers.get(FORWARDED_FOR).into_iter().collect(),", NAMES),
    ("forwarded-every-field", EDGE, "forwarded: req.headers.all(FORWARDED),",
     "forwarded: req.headers.get(FORWARDED).into_iter().collect(),", NAMES),
    ("one-list-not-first-field", EDGE, ".flat_map(|line| line.split(','))",
     ".take(1).flat_map(|line| line.split(','))", "repeated_fields_are_one_list"),
    # Right to left becomes left to right: the client's own hop is believed.
    ("walk-from-the-right", EDGE, "for hop in hops.iter().rev() {", "for hop in hops.iter() {",
     "repeated_fields_are_one_list"),
    ("untrusted-peer-unread", EDGE, "match (offered, from_proxy) {", "match (offered, true) {",
     "ipv6_hops_are_walked"),
    # The line: only where the fields are read, only for a repeat, rate-limited,
    # counting what it did not write, and written at all.
    ("joined-only-from-a-proxy", EDGE, "(from_proxy && (fields.0 > 1 || fields.1 > 1))",
     "((fields.0 > 1 || fields.1 > 1))", "counted_only_where_they_are_read"),
    ("joined-needs-a-repeat", EDGE, "(fields.0 > 1 || fields.1 > 1)", "(fields.0 > 0 || fields.1 > 0)",
     JOINED),
    ("joined-rate-limited", EDGE, "at.abs_diff(now) < JOINED_LOG_INTERVAL_SECS", "false", JOINED),
    ("joined-counts-the-rest", EDGE, "Some(std::mem::take(unlogged))", "Some(1)", JOINED),
    ("joined-is-written", API, "self.forwarding_joined(fields);", "let _ = fields;", JOINED),
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
                    text=True, timeout=600, check=False,
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
