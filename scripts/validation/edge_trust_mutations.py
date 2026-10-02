#!/usr/bin/env python3
"""Reproduce the generic-deploy guard probes from the repository root.

Each probe breaks one guard of the edge-trust, forwarded-header, trust-default,
listener or chart change. A server probe must compile and fail a behavioral
test; a chart or reader probe must turn its gate red with a refusal. Sources
are restored from their exact starting bytes in finally, including on failure
or interrupt. Never run beside another build or source editor in this
worktree. Needs cargo, and helm for the chart probes.
"""
from pathlib import Path
import os
import subprocess

from kills import Judge

EDGE = "crates/obsyncd/src/api/edge.rs"
CONFIG = "crates/obsyncd/src/config.rs"
SERVE = "crates/obsyncd/src/cli/serve.rs"
SCHEMA = "chart/values.schema.json"
POLICY = "chart/templates/network-policy.yaml"
READER = "scripts/ci/miniyaml.py"
PINS = ["python3", "-B", "scripts/ci/chart_pins.py", "all"]
CASES = [
    ("edge-refuses-untrusted-peer", EDGE, "        if !from_proxy {\n", "        if false {\n", "edge_headers_from_a"),
    ("edge-request-id-required", EDGE, "if single(&headers.request_id).is_none() {", "if false {", "edge_mode_requires_the_request_id"),
    ("edge-header-single", EDGE, "        [line] => Some(line.trim())", "        [line, ..] => Some(line.trim())", "repeated_edge_header"),
    ("peer-canonical", EDGE, "    let peer = peer.to_canonical();", "    let peer = peer;", "mapped_ipv4"),
    ("hop-canonical", EDGE, "    Some(ip.to_canonical())", "    Some(ip)", "mapped_ipv4"),
    ("none-mode-binds-peer", EDGE, "match (offered, from_proxy) {", "match (offered, true) {", "ignores_forwarded_from_an_untrusted_peer"),
    ("every-header-line", EDGE, "forwarded_for: req.headers.all(FORWARDED_FOR),", "forwarded_for: req.headers.get(FORWARDED_FOR).into_iter().collect(),", "a_trusted_proxy_names_the_client"),
    ("headers-must-agree", EDGE, "            if a == b {", "            if true {", "both_headers_must_name_the_same_client"),
    ("walk-stops-at-unreadable", EDGE, "        let ip = node_ip(hop)?;", "        let Some(ip) = node_ip(hop) else { continue };", "unreadable_hop"),
    ("forwarded-for-parameter", EDGE, '.find(|(name, _)| name.trim().eq_ignore_ascii_case("for"))', ".next()", "rfc_7239_nodes_parse"),
    ("edge-private-default", CONFIG, "            cfg.trusted_proxy_cidrs = private_networks();", "            cfg.trusted_proxy_cidrs = Vec::new();", "edge_mode"),
    ("private-networks-cover-pods", CONFIG, '        "10.0.0.0/8",\n', "", "trusts_private_peers"),
    ("no-zero-prefix", CONFIG, "Some(block) if block.prefix == 0 =>", "Some(block) if false =>", "bad_values_are_refused_by_variable"),
    ("dual-stack-default", CONFIG, 'listen: "[::]:8080".parse()', 'listen: "0.0.0.0:8080".parse()', "defaults_match_the_documented_table"),
    ("fallback-not-on-in-use", SERVE, "&& e.kind() != io::ErrorKind::AddrInUse", "", "only_the_unspecified_ipv6_listener"),
    ("fallback-only-unspecified", SERVE, "(addr.ip() == Ipv6Addr::UNSPECIFIED && ", "(", "only_the_unspecified_ipv6_listener"),
    # Chart and reader guards: the selector is the gate command itself.
    ("no-peer-renders-no-rule", POLICY, "  {{- if $peers }}\n", "  {{- if true }}\n", PINS),
    # Each single-peer field requires the other two; one alone is redundant
    # with its siblings, so the whole rule is the unit that can be removed.
    ("single-peer-needs-all-three", SCHEMA,
     ',\n      "dependencies": {\n        "peerNamespace": ["peerAppName", "peerInstance"],\n'
     '        "peerAppName": ["peerNamespace", "peerInstance"],\n'
     '        "peerInstance": ["peerNamespace", "peerAppName"]\n      }', "", PINS),
    ("no-slash-zero-block", SCHEMA, "/(?:[1-9]|[12][0-9]|3[0-2])$|", "/(?:[0-9]|[12][0-9]|3[0-2])$|", PINS),
    # What stops one entry naming a pod AND a block is the closed pod shape;
    # opened, the block wins in the template and the pod's facts vanish.
    ("pod-or-block-not-both", SCHEMA,
     '"type": "object",\n          "additionalProperties": false,\n          "required": ["namespace", "appName", "instance"],',
     '"type": "object",\n          "required": ["namespace", "appName", "instance"],', PINS),
    ("selector-labels-reserved", SCHEMA, '"propertyNames": { "not": { "pattern": "^app\\\\.kubernetes\\\\.io/" } },', "", PINS),
    ("reader-refuses-dash-keys", READER, '        if content.startswith("- ") or content == "-":\n', "        if False:\n",
     ["python3", "-B", "-m", "unittest", "scripts/ci/test_miniyaml.py"]),
]


def run(selector, judge):
    """A cargo selector is judged by `kills.Judge`; a command's kill is a
    refusal or a failed assertion, never an error."""
    if not isinstance(selector, list):
        return judge.test(selector)
    plain = {**os.environ, "NO_COLOR": "1", "PYTHON_COLORS": "0"}
    result = subprocess.run(selector, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                            text=True, timeout=600, check=False, env=plain)
    failed = [line for line in result.stdout.splitlines() if "DENY" in line or line.startswith("FAIL:")]
    if result.returncode != 0 and failed:
        return "KILLED", "\n".join(failed)
    return "NOT A KILL", result.stdout


def main():
    originals = {Path(path): Path(path).read_bytes() for _, path, *_ in CASES}
    failures = []
    judge = Judge({("obsyncd", case[-1]) for case in CASES if not isinstance(case[-1], list)})
    try:
        for name, path, old, new, selector in CASES:
            source = originals[Path(path)].decode()
            if source.count(old) != 1:
                raise RuntimeError(f"{name}: mutation context moved")
            Path(path).write_text(source.replace(old, new, 1))
            try:
                verdict, evidence = run(selector, judge)
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
    print(f"All {len(CASES)} probes were killed.")


if __name__ == "__main__":
    main()
