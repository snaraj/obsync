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
# The two `docker build` entries are the gate's `container` job and the
# Makefile's `image` target, and they are TWO entries because they prove
# different things: `--target server` stops at the stage that runs the Rust
# battery inside the image and cross-links the static binary, while the
# untargeted build adds the plugin, bundle and final stages. Either one alone
# leaves half the Dockerfile unbuilt until release time. `image-smoke.sh` is
# the third of that group and the only one that RUNS the result: both builds
# were green on an image that exited at first boot, because a build proves
# nothing about a mount point the runtime uid cannot write. The three are the
# one group here that `make check` does not chain -- `check` must stay
# runnable with no container runtime -- so `make image` is where an author
# reproduces them.
#
# TEXT IS NOT EXECUTION. This script used to answer "does the file contain this
# command" with `grep -qF`. An adversarial review answered yes while running
# nothing: `true # ./scripts/ci/image-smoke.sh obsync:$(cat VERSION)` in the
# recipe and `run: true # scripts/ci/image-smoke.sh "obsync-gate-full:…"` in
# the workflow both passed every pin, actionlint included, with the one check
# that had just caught a deployment-blocking defect switched off. So both sides
# are now read for what they RUN. The Makefile side is its TAB-indented recipe
# lines, backslash continuations joined, Make's `@-+` prefixes and shell
# comments stripped -- a column-0 comment is not a recipe line and can never
# count. The workflow side is every step `run:` value that
# scripts/ci/workflow_runs.py resolves through the repository's fail-closed
# YAML reader. Both are split into shell segments on `&&`, `||`, `|` and `;`,
# lose leading bare `NAME=value` assignments and the grammar words that stand
# before a command without changing it, and a canonical command must STAND AT
# THE HEAD of some segment. `cd plugin && npm ci …` still counts. `true # …`,
# `echo '…'` and a comment do not, and neither does a segment the line cannot
# reach: one behind `||`, or one joined by `&&` after a bare `false` or `!`.
# The same review that beat the text search beat a sibling contract with
# `false && …`. On the workflow side a step or job carrying an `if:` is skipped
# whole for the same reason: `if: false` on the smoke step is that same
# neutralization written in YAML.
#
# NON-VACUITY IS PROVEN, NOT ASSUMED. Assertion (d) mutates a COPY of each file
# thirteen ways -- deleting a canonical command, moving it into a comment,
# neutralizing it with `true #` or `echo`, hiding it in a comment that carries
# a `;`, and putting it behind a `false &&`, a `||`, or an `if:` -- and
# requires the same check to refuse every one. A gate that had stopped being
# able to fail would fail here instead of passing silently forever.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
makefile="${MAKEFILE_PATH:-Makefile}"
workflow="${WORKFLOW_PATH:-.github/workflows/pr-gate.yml}"

CANONICAL=(
  'cargo fmt --all --check'
  'cargo clippy --workspace --all-targets -- -D warnings'
  'cargo test --workspace'
  './scripts/ci/coverage.sh'
  'npm ci --ignore-scripts --no-audit --no-fund'
  'npm run build'
  'npm test'
  'node --test dashboard/test/*.test.mjs'
  'helm lint chart'
  'helm template smoke chart --kube-version v1.36.0'
  'python3 -B scripts/ci/chart_pins.py all'
  "python3 -B -m unittest discover -s scripts/ci -p 'test_*.py'"
  'gitleaks dir --no-banner --redact'
  'gitleaks git --no-banner --redact --max-target-megabytes=2'
  'docker build --target server --tag'
  'docker build --tag'
  'scripts/ci/image-smoke.sh'
)

# The prerequisite list `check` must carry. Stated here so a target silently
# dropped from the chain -- which leaves `make check` green while running less
# -- is a failure rather than a difference nobody notices.
CHECK_PREREQUISITES='fmt lint test coverage plugin dashboard chart contracts secrets'

fail() {
  printf 'makefile-invariants: %s\n' "$1" >&2
  exit 1
}

makefile_segments() {
  # Every executable shell segment of every recipe line in $1, one per line.
  awk '
    /^\t/ {
      line = substr($0, 2)
      if (line ~ /\\$/) {
        pending = pending substr(line, 1, length(line) - 1) " "
        next
      }
      emit(pending line)
      pending = ""
      next
    }
    { pending = "" }
    END { if (pending != "") emit(pending) }
    function emit(line,   segment, operator, following, dead, previous) {
      sub(/^[ \t]*[-@+]*[ \t]*/, "", line)
      sub(/(^|[ \t])#.*$/, "", line)
      operator = ""
      dead = 0
      while (1) {
        if (match(line, /\|\||&&|[|;]/)) {
          segment = substr(line, 1, RSTART - 1)
          following = substr(line, RSTART, RLENGTH)
          line = substr(line, RSTART + RLENGTH)
        } else {
          segment = line
          following = ""
          line = ""
        }
        do {
          previous = segment
          sub(/^[ \t]+/, "", segment)
          sub(/^[A-Za-z_][A-Za-z0-9_]*=[^ \t'"'"'"]*[ \t]+/, "", segment)
          sub(/^(then|else|elif|do|\{|\()[ \t]+/, "", segment)
        } while (segment != previous)
        sub(/[ \t]+$/, "", segment)
        if (operator == "" || operator == ";" || operator == "|") dead = 0
        if (segment != "" && dead == 0 && operator != "||") print segment
        if (segment == "false" || segment == "!") dead = 1
        if (following == "") break
        operator = following
      }
    }
  ' "$1"
}

workflow_segments() {
  python3 -B "${here}/workflow_runs.py" "$1"
}

runs_command() {
  # 0 when some segment in $1 STARTS WITH the command $2. A leading `./` is not
  # part of the decision: `./scripts/ci/image-smoke.sh` and
  # `scripts/ci/image-smoke.sh` are the same program run the same way.
  local segments="$1" command="${2#./}" segment
  while IFS= read -r segment; do
    segment="${segment#./}"
    if [ "${segment#"${command}"}" != "${segment}" ]; then
      return 0
    fi
  done <<< "${segments}"
  return 1
}

battery_holds() {
  # 0 when every canonical command heads a segment in BOTH files, 1 otherwise.
  # Quiet: assertion (d) calls it expecting failure.
  local makefile_path="$1" workflow_path="$2" command recipes runs
  recipes="$(makefile_segments "${makefile_path}")" || return 1
  runs="$(workflow_segments "${workflow_path}" 2>/dev/null)" || return 1
  for command in "${CANONICAL[@]}"; do
    runs_command "${recipes}" "${command}" || return 1
    runs_command "${runs}" "${command}" || return 1
  done
  return 0
}

[ -f "${makefile}" ] || fail "no ${makefile} in $(pwd)"
[ -f "${workflow}" ] || fail "no ${workflow} in $(pwd)"

# (a) Every canonical command is RUN by both files.
recipes="$(makefile_segments "${makefile}")" || fail "cannot read ${makefile}'s recipes"
runs="$(workflow_segments "${workflow}")" || fail "cannot resolve ${workflow}"
for command in "${CANONICAL[@]}"; do
  runs_command "${recipes}" "${command}" \
    || fail "the Makefile no longer runs: ${command}"
  runs_command "${runs}" "${command}" \
    || fail "${workflow} no longer runs: ${command}"
done
printf 'makefile-invariants: (a) all %d canonical commands are run by both %s and %s\n' \
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

# (d) The check can fail. Break one canonical command on a COPY of each file --
# by deletion, and by every way of naming it without running it -- and require
# the same comparison to refuse each one.
scratch="$(mktemp -d "${TMPDIR:-/tmp}/makefile-invariants.XXXXXX")"
trap 'rm -rf -- "${scratch}"' EXIT
probe='cargo clippy --workspace --all-targets -- -D warnings'
block='npm run build'
tab="$(printf '\t')"

rewrite() {
  # Copy $1 to $2, replacing the first line that contains $3 with $4.
  awk -v needle="$3" -v replacement="$4" \
    '!replaced && index($0, needle) { print replacement; replaced = 1; next } { print }' \
    "$1" > "$2"
}

refuses() {
  # $1 names the mutant; the copies in ${scratch} are judged as a pair.
  if battery_holds "${scratch}/Makefile" "${scratch}/workflow.yml"; then
    fail "$1 still passed; this gate cannot fail"
  fi
}

cp "${workflow}" "${scratch}/workflow.yml"
grep -vF -- "${probe}" "${makefile}" > "${scratch}/Makefile"
refuses "a Makefile with '${probe}' deleted"
rewrite "${makefile}" "${scratch}/Makefile" "${probe}" "${tab}true # ${probe}"
refuses "a Makefile whose recipe reads 'true # ${probe}'"
rewrite "${makefile}" "${scratch}/Makefile" "${probe}" "${tab}echo '${probe}'"
refuses "a Makefile whose recipe only echoes '${probe}'"
rewrite "${makefile}" "${scratch}/Makefile" "${probe}" "# ${probe}"
refuses "a Makefile naming '${probe}' in a comment instead of a recipe"
rewrite "${makefile}" "${scratch}/Makefile" "${probe}" "${tab}true # disabled; ${probe}"
refuses "a Makefile whose recipe hides '${probe}' in a comment carrying a ';'"
rewrite "${makefile}" "${scratch}/Makefile" "${probe}" "${tab}false && ${probe}"
refuses "a Makefile whose recipe reaches '${probe}' only after a false"
rewrite "${makefile}" "${scratch}/Makefile" "${probe}" "${tab}true || ${probe}"
refuses "a Makefile whose recipe reaches '${probe}' only through a '||'"

cp "${makefile}" "${scratch}/Makefile"
grep -vF -- "${probe}" "${workflow}" > "${scratch}/workflow.yml"
refuses "a workflow with '${probe}' deleted"
rewrite "${workflow}" "${scratch}/workflow.yml" "run: ${probe}" \
  "        run: true # ${probe}"
refuses "a workflow step whose run value reads 'true # ${probe}'"
rewrite "${workflow}" "${scratch}/workflow.yml" "          ${block}" \
  "          # ${block}"
refuses "a workflow block scalar with '${block}' commented out"
rewrite "${workflow}" "${scratch}/workflow.yml" "          ${block}" \
  "          true # disabled; ${block}"
refuses "a workflow block scalar hiding '${block}' in a comment carrying a ';'"
rewrite "${workflow}" "${scratch}/workflow.yml" "          ${block}" \
  "          false && ${block}"
refuses "a workflow block scalar reaching '${block}' only after a false"
rewrite "${workflow}" "${scratch}/workflow.yml" "run: ${probe}" \
  "        if: false\n        run: ${probe}"
refuses "a workflow step that runs '${probe}' only when a condition holds"
printf 'makefile-invariants: (d) deleting, commenting or neutralizing one canonical command in either file is refused\n'

printf 'makefile-invariants: the Makefile and the PR gate run one battery\n'
