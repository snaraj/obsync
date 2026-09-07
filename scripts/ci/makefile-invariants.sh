#!/usr/bin/env bash
# makefile-invariants -- prove `make check` and the PR gate run the SAME
# battery.
#
# AGENTS.md, "Build, test, and release flows", says `make check` is the
# canonical gate and CI runs the same battery. That sentence is worth exactly
# as much as whatever enforces it: without this script the two drift silently,
# and the drift is always in the same direction -- a check quietly dropped from
# one side while every reader still sees it declared on the other. Both failure
# modes are real and both are bad. A command in the Makefile but not in CI is a
# check the merge does not run. A command in CI but not the Makefile is a check
# no author can reproduce before pushing, which is how a red main happens.
#
# WHAT IT PINS -- BEHAVIOUR, NOT INVENTORY. The list below is the set of
# commands whose ABSENCE would change what the gate means. It is not a census
# of every line in either file: adding a step to CI, or a target to the
# Makefile, needs no edit here. Only removing one of these does.
#
# The npm flags are pinned as a set rather than as the word `npm ci`, and
# `--ignore-scripts` is the reason: it is the difference between installing a
# compiler and executing whatever install hooks a dependency tree carries
# (requirement 5).
#
# NON-VACUITY IS PROVEN, NOT ASSUMED. Assertion (d) deletes one canonical
# command from a COPY of each file and requires the same check to fail. A gate
# that had stopped being able to fail would fail here instead of passing
# silently forever.
set -euo pipefail

makefile="${MAKEFILE_PATH:-Makefile}"
workflow="${WORKFLOW_PATH:-.github/workflows/pr-gate.yml}"

CANONICAL=(
  'cargo fmt --all --check'
  'cargo clippy --workspace --all-targets -- -D warnings'
  'cargo test --workspace'
  'scripts/ci/coverage.sh'
  'npm ci --ignore-scripts --no-audit --no-fund'
  'npm run build'
  'npm test'
  'node --test dashboard/test/'
  'helm lint chart'
  'helm template smoke chart --kube-version v1.36.0'
  'python3 -B scripts/ci/chart_pins.py all'
  "python3 -B -m unittest discover -s scripts/ci -p 'test_*.py'"
  'gitleaks dir --no-banner --redact'
  'gitleaks git --no-banner --redact --max-target-megabytes=2'
)

# The prerequisite list `check` must carry. Stated here so a target silently
# dropped from the chain -- which leaves `make check` green while running less
# -- is a failure rather than a difference nobody notices.
CHECK_PREREQUISITES='fmt lint test coverage plugin dashboard chart contracts secrets'

fail() {
  printf 'makefile-invariants: %s\n' "$1" >&2
  exit 1
}

battery_holds() {
  # 0 when every canonical command appears in BOTH files, 1 otherwise. Quiet:
  # assertion (d) calls it expecting failure.
  local makefile_path="$1" workflow_path="$2" command
  for command in "${CANONICAL[@]}"; do
    grep -qF -- "${command}" "${makefile_path}" || return 1
    grep -qF -- "${command}" "${workflow_path}" || return 1
  done
  return 0
}

[ -f "${makefile}" ] || fail "no ${makefile} in $(pwd)"
[ -f "${workflow}" ] || fail "no ${workflow} in $(pwd)"

# (a) Every canonical command is in both files.
for command in "${CANONICAL[@]}"; do
  grep -qF -- "${command}" "${makefile}" \
    || fail "the Makefile no longer runs: ${command}"
  grep -qF -- "${command}" "${workflow}" \
    || fail "${workflow} no longer runs: ${command}"
done
printf 'makefile-invariants: (a) all %d canonical commands appear in both %s and %s\n' \
  "${#CANONICAL[@]}" "${makefile}" "${workflow}"

# (b) `make check` still chains every target that carries one of them.
observed="$(awk -F: '/^check:/{sub(/ *#.*/, "", $2); print $2; exit}' "${makefile}" \
  | tr -s ' ' | sed 's/^ *//; s/ *$//')"
if [ "${observed}" != "${CHECK_PREREQUISITES}" ]; then
  fail "check's prerequisites are '${observed}' and must be '${CHECK_PREREQUISITES}'"
fi
printf 'makefile-invariants: (b) check chains exactly: %s\n' "${CHECK_PREREQUISITES}"

# (c) Positive control: make help runs, so the refusals below prove REJECTION
# of a broken file specifically -- never a check that simply never passes.
if ! make -f "${makefile}" help >/dev/null 2>&1; then
  fail "make help failed; the Makefile does not parse"
fi
printf 'makefile-invariants: (c) the Makefile parses and make help runs (non-vacuous)\n'

# (d) The check can fail. Remove one canonical command from a COPY of each file
# and require the same comparison to refuse it.
scratch="$(mktemp -d "${TMPDIR:-/tmp}/makefile-invariants.XXXXXX")"
trap 'rm -rf -- "${scratch}"' EXIT
probe='cargo clippy --workspace --all-targets -- -D warnings'
grep -vF -- "${probe}" "${makefile}" > "${scratch}/Makefile"
cp "${workflow}" "${scratch}/workflow.yml"
if battery_holds "${scratch}/Makefile" "${scratch}/workflow.yml"; then
  fail "a Makefile with '${probe}' deleted still passed; this gate cannot fail"
fi
cp "${makefile}" "${scratch}/Makefile"
grep -vF -- "${probe}" "${workflow}" > "${scratch}/workflow.yml"
if battery_holds "${scratch}/Makefile" "${scratch}/workflow.yml"; then
  fail "a workflow with '${probe}' deleted still passed; this gate cannot fail"
fi
printf 'makefile-invariants: (d) deleting one canonical command from either file is refused\n'

printf 'makefile-invariants: the Makefile and the PR gate run one battery\n'
