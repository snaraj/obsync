#!/bin/sh
# Run one mutation of the server's dedupe key against the obsyncd library
# suite.
#
#   crates/obsyncd/mutants/run.sh crates/obsyncd/mutants/S01.diff
#   crates/obsyncd/mutants/run.sh                # every mutant beside it
#
# Each `.diff` is an exact unified diff against `crates/obsyncd/src` at the
# head that carries it, with its subject on its first line, so every kill
# count in a commit body or a PR body is reproducible by a stranger with one
# command (review round 5, finding 7). The output names every test that
# failed, and their number IS the kill count.
#
# EXACT, NEVER FUZZY. `-F0` refuses a hunk whose context has moved: a patch
# that no longer describes the code it was written for must fail loudly
# rather than land somewhere it was never written for.
#
# THE TREE IS RESTORED FROM A COPY, NEVER FROM GIT. `git checkout --` would
# erase uncommitted work belonging to whoever is running this, so the source
# is copied aside first, copied back on every exit path including an
# interrupt, and verified against that copy.
set -eu

root="$(cd "$(dirname "$0")/../../.." && pwd)"
here="${root}/crates/obsyncd/mutants"
pristine="$(mktemp -d)"
cp -R "${root}/crates/obsyncd/src/." "${pristine}/"

restore() {
  status=$?
  find "${root}/crates/obsyncd/src" \( -name '*.orig' -o -name '*.rej' \) -exec rm -f {} +
  cp -R "${pristine}/." "${root}/crates/obsyncd/src/"
  if ! diff -r -q "${pristine}" "${root}/crates/obsyncd/src" >/dev/null; then
    printf 'MUTANT LEFT IN THE TREE: restore crates/obsyncd/src from %s by hand\n' "${pristine}" >&2
    exit 2
  fi
  rm -rf "${pristine}"
  exit "${status}"
}
trap restore EXIT INT TERM

one() {
  printf '=== %s ===\n' "$(basename "$1")"
  if ! patch -s -F0 -p1 -d "${root}" <"$1"; then
    printf 'PATCH DOES NOT APPLY: this mutant no longer describes this head\n'
    return 0
  fi
  (cd "${root}" && cargo test -p obsyncd --lib 2>&1) |
    grep -E '^(test .* FAILED|test result:|error\[)' || true
  patch -s -R -F0 -p1 -d "${root}" <"$1"
}

if [ "$#" -gt 0 ]; then
  for patch_file in "$@"; do one "${patch_file}"; done
else
  for patch_file in "${here}"/S*.diff; do one "${patch_file}"; done
fi
