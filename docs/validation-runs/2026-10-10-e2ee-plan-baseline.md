# 2026-10-10: E2EE audit-plan baseline and scanner counterexamples

This is a bounded source/test investigation for [the audit plan](../security/e2ee-audit-plan.md),
issue #344. It is not execution of that plan or a whole-product E2EE verdict.
All inputs below are synthetic. No personal vault, live server, account,
physical device or production credential took part.

## Source and build identity

- Released source: `1.1.7`, commit
  `c2796b7a5b6abd38be23b4f93c6fb620ab7688c0`.
- Investigation checkout: PR #345's documentation-only predecessor
  `55442862d68eaee9ebff12a25f878c0a3d58cd8e`, whose runtime/test files match
  that release. The revision changes only this record and the audit plan.
- Platform: macOS `27.0`, arm64; Node `v26.10.0`, npm `11.19.1`,
  TypeScript `5.9.3`, Rust/Cargo `1.98.0`, Python `3.14.8` (queried with
  `sw_vers -productVersion`, `uname -m` and each tool's version command).
- Build: `cd plugin && npm ci --ignore-scripts --no-audit --no-fund && npm run build`.
  The run used an isolated npm cache. It built 27 modules.
- Built `plugin/dist/main.js`: 1,403,979 bytes, SHA-256
  `8b0488c5d83b6c0d2991dba73af8512fa2be8a3e2b9279994a114261a7a184c4`.
  This identifies the tested bundle; it is not an installed-device measurement
  or a byte-for-byte comparison with downloaded release assets.

## Executed checks

| Check | Observed result | Limit |
| --- | --- | --- |
| Focused plugin tests below | 248 passed; zero failures, cancellations, skips or todos | Node harness, not native Obsidian |
| `cargo test --locked -p obsync-core` | 152 passed, zero failures, one ignored throughput measurement; zero doctests | Core primitives/parsers, not whole-server or plugin integration |
| `python3 -B -m unittest discover -s scripts/ci -p test_observer.py` | Nine passed | Existing scanner tests miss the counterexamples below |
| Scanner counterexamples | Four false PASS results and one correctly failing plaintext control | Synthetic capture files, not observed product leakage |

The first Rust attempt in a sandbox had 129 passes, 23 failures and one
ignored test. Socket-binding tests reported `PermissionDenied` / `Operation
not permitted`. Repeating the same command with local socket access allowed
produced the 152-pass result. The environmental failure is retained here,
not silently counted as a product failure or a passing run.

To reproduce the focused plugin selection after building, run from the
repository root. A temporary root contains the test fixtures and is removed
on exit; the observed run left no children in it before cleanup.

```sh
python3 -B - <<'PY'
import os
import subprocess
import tempfile
from pathlib import Path

names = [
    "crypto", "pairing-v2", "pairing-claim", "pairing-vault-ui", "binding",
    "vault-identity", "account-recovery", "credential-lifecycle", "keys-lost",
    "domainmap", "merge-inputs",
]
with tempfile.TemporaryDirectory(prefix="obsync-e2ee-baseline-") as tmp:
    env = dict(os.environ, TMPDIR=tmp, TMP=tmp, TEMP=tmp)
    result = subprocess.run(
        ["node", "--test", "--test-reporter=tap"]
        + [f"test/{name}.test.mjs" for name in names],
        cwd="plugin", env=env, check=False,
    )
    print("remaining fixture entries:", len(list(Path(tmp).iterdir())))
    raise SystemExit(result.returncode)
PY
```

## Scanner false-PASS reproduction

The scanner's command-line verdict in `scripts/ci/observer.mjs` depends on
`hits.length`. It does not require a nonempty corpus or capture, and its HTTP
parser does not scan every raw byte. These observations explain the following
results; they do not establish that obsync transmitted a real secret.

| Case | Exit | Decision | Needles | Connections | Requests | Responses | Hits |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Empty capture | 0 | pass | 1 | 0 | 0 | 0 | 0 |
| Empty needle inventory, plaintext request | 0 | pass | 0 | 1 | 1 | 0 | 0 |
| Incomplete header containing plaintext | 0 | pass | 1 | 1 | 0 | 0 | 0 |
| Close-delimited response containing plaintext | 0 | pass | 1 | 1 | 0 | 1 | 0 |
| Complete plaintext request, positive control | 1 | fail | 1 | 1 | 1 | 0 | 1 |

Run from the repository root. The marker is public synthetic text, never a
credential. Each case's files are removed even if parsing or execution fails.

```sh
python3 -B - <<'PY'
import json
import subprocess
import tempfile
from pathlib import Path

observer = Path("scripts/ci/observer.mjs").resolve()
needle = "SENTINEL-e2ee-audit-no-private-data"
complete = (
    "POST /v1/x HTTP/1.1\r\nHost: obsync.invalid\r\n"
    f"Content-Length: {len(needle)}\r\n\r\n{needle}"
).encode()
spec = {"text": {"note": needle}}
cases = [
    ("empty_capture", None, None, spec),
    ("empty_needles", complete, None, {}),
    ("incomplete_header", ("POST /v1/x HTTP/1.1\r\nX-Test: " + needle).encode(), None, spec),
    ("close_delimited_response", None,
     ("HTTP/1.1 200 OK\r\nConnection: close\r\n\r\n" + needle).encode(), spec),
    ("plaintext_control", complete, None, spec),
]
results = []
for name, up, down, needles in cases:
    with tempfile.TemporaryDirectory(prefix="obsync-e2ee-scanner-") as tmp:
        root = Path(tmp)
        capture = root / "capture"
        capture.mkdir()
        for suffix, data in (("up", up), ("down", down)):
            if data is not None:
                (capture / f"c1.{suffix}").write_bytes(data)
        inventory = root / "needles.json"
        inventory.write_text(json.dumps(needles))
        run = subprocess.run(
            ["node", str(observer), "scan", "--capture", str(capture),
             "--needles", str(inventory), "--json"],
            capture_output=True, text=True, check=False,
        )
        out = json.loads(run.stdout)
        results.append({
            "case": name, "exit": run.returncode,
            **{key: out[key] for key in
               ("decision", "needles", "connections", "requests", "responses")},
            "hits": len(out["hits"]),
        })
print(json.dumps(results, indent=2))
PY
```

Repair acceptance must require validated needles, expected flows and byte
coverage, with a refusal for missing/incomplete evidence. Scan raw bytes and
decoded structures; test framing/decompression/recorder failures. A capture
cannot be called clean merely because its parser produced nothing to scan.
The positive control must continue failing after those repairs.

## Other source observations and limits

`crates/obsyncd/src/cli/mod.rs:ExportArgs::parse` requires a 32-byte domain
key supplied by `--key-file` or `--key`. `cli/export.rs:run` immediately ignores
the supplied key and exports encrypted records/chunks. The architecture still
instructs users to supply this key to the server binary. This is unnecessary
content-key input on a server interface, requiring removal from parsing/help/
guidance. This investigation did not execute export with real keys or establish
a remote key leak or an existing server-side decryption capability.

The plan also corrects the predecessor's recovery-proof documentation claim:
`docs/threat-model.md` already identifies that credential and its visibility
to a TLS terminator. Its legitimate recovery field must be distinguished from
content-decryption keys and unauthorized sinks. Deterministic chunk equality
likewise needs an explicit chosen-input adversary, not an unqualified claim
that confirmation is impossible without the domain key.

Not executed here: a real plugin-to-server observer session; server-volume
scanning; whole-server/CLI security testing; active malicious-server journeys;
native desktop/phone acceptance; key-rotation implementation; live provider,
ruleset or publication-enforcement validation; release or installation. The
plan makes those separate evidence obligations. No security invariant was
added by this documentation revision, so there is no new executable guard to
mutation-test; the counterexamples test the existing scanner's limits.
