#!/usr/bin/env python3
"""Reproduce the #201 platform-annotation guard probes from the repository root.

Each probe replaces one exact span of the chart, requires the shipped default
to still render (a probe that breaks the template tests nothing), runs the
chart-pin tests with helm on PATH, and must produce at least one assertion
FAILURE (an error alone is not a kill). Sources are restored from their exact
starting bytes in finally, including on failure or interrupt. Never run beside
another editor in this worktree. Arguments, if any, are name prefixes that
select a subset (`deployment-`).
"""
from pathlib import Path
import os
import subprocess
import sys

HELPERS = "chart/templates/_helpers.tpl"
DEPLOYMENT = "chart/templates/deployment.yaml"
STORAGE = "chart/templates/storage.yaml"
PIN_TESTS = ["-p", "test_chart_pins.py"]
READY_KEY = "  {{- if $domain }}\n  annotations:\n    {{ $domain }}/deployment-ready"
CAPACITY_KEY = "  {{- if $domain }}\n  annotations:\n    {{ $domain }}/volume-capacity"
PATTERN = "(not (regexMatch `^[a-z0-9]([-a-z0-9]*[a-z0-9])?(\\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*$` $domain))"
LENGTH = "(gt (len $domain) 253)"
RESERVED = '{{- if or (eq $domain "kubernetes.io" "k8s.io") (hasSuffix ".kubernetes.io" $domain) (hasSuffix ".k8s.io" $domain) -}}'
NOT_A_SUBDOMAIN = "(printf \"platform.annotationDomain %q is not a DNS subdomain: lower-case letters, digits, '-' and '.', every label starting and ending with a letter or digit, 253 characters at most\" $domain)"
RESERVED_PREFIX = '(printf "platform.annotationDomain %q is a prefix Kubernetes reserves for its own components; name your platform\'s domain" $domain)'
CASES = [
    ("deployment-always-emits", DEPLOYMENT, READY_KEY, READY_KEY.replace("if $domain", "if true")),
    ("deployment-inverted", DEPLOYMENT, READY_KEY, READY_KEY.replace("if $domain", "if not $domain")),
    ("storage-always-emits", STORAGE, CAPACITY_KEY, CAPACITY_KEY.replace("if $domain", "if true")),
    ("storage-inverted", STORAGE, CAPACITY_KEY, CAPACITY_KEY.replace("if $domain", "if not $domain")),
    ("validation-no-subdomain-pattern", HELPERS, PATTERN, "false"),
    ("validation-no-length-bound", HELPERS, LENGTH, "false"),
    ("validation-length-off-by-one", HELPERS, LENGTH, "(gt (len $domain) 252)"),
    ("validation-refusal-names-no-value", HELPERS, NOT_A_SUBDOMAIN, '"platform.annotationDomain is not a DNS subdomain"'),
    ("reserved-no-refusal", HELPERS, RESERVED, "{{- if false -}}"),
    ("reserved-no-exact-prefix", HELPERS, '(eq $domain "kubernetes.io" "k8s.io") ', ""),
    ("reserved-no-kubernetes.io-subdomain", HELPERS, '(hasSuffix ".kubernetes.io" $domain) ', ""),
    ("reserved-no-k8s.io-subdomain", HELPERS, ' (hasSuffix ".k8s.io" $domain)', ""),
    ("reserved-suffix-without-dot", HELPERS, '(hasSuffix ".k8s.io" $domain)', '(hasSuffix "k8s.io" $domain)'),
    ("reserved-refusal-names-no-value", HELPERS, RESERVED_PREFIX, '"platform.annotationDomain is a reserved prefix"'),
]


def main():
    selected = [case for case in CASES if not sys.argv[1:] or case[0].startswith(tuple(sys.argv[1:]))]
    originals = {Path(path): Path(path).read_bytes() for _, path, *_ in selected}
    failures = []
    try:
        for name, path, old, new in selected:
            source = originals[Path(path)].decode()
            if source.count(old) != 1:
                raise RuntimeError(f"{name}: mutation context moved")
            Path(path).write_text(source.replace(old, new, 1))
            try:
                renders = subprocess.run(
                    ["helm", "template", "probe", "chart", "--kube-version", "v1.36.0"],
                    stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True, check=False,
                )
                result = subprocess.run(
                    ["python3", "-B", "-m", "unittest", "discover", "-s", "scripts/ci", *PIN_TESTS],
                    stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                    text=True, timeout=600, check=False, env={**os.environ, "PYTHON_COLORS": "0"},
                )
                summary = next((line for line in result.stdout.splitlines()
                                if line.startswith(("OK", "FAILED ("))), "no unittest summary")
                killed = renders.returncode == 0 and result.returncode != 0 and "failures=" in summary
                # The test name and, for `test_each_pin_holds`, the pin that failed.
                failed = sorted({line.split(" (")[0] + "".join(f" ({part}" for part in line.split(" (")[2:])
                                 for line in result.stdout.splitlines() if line.startswith("FAIL: ")})
                verdict = "KILLED" if killed else "NOT A KILL"
                if renders.returncode != 0:
                    verdict += " (the default no longer renders: " + renders.stderr.strip() + ")"
                print(f"{name}: {verdict} {summary}", flush=True)
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
    print(f"All {len(selected)} probes rendered and were killed by an assertion failure.")


if __name__ == "__main__":
    main()
