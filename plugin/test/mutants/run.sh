#!/bin/sh
# Run one mutation of the plugin source against the whole plugin suite.
#
#   plugin/test/mutants/run.sh plugin/test/mutants/M16.diff
#
# Each `.diff` beside this script is a unified diff against `plugin/src` (or
# `plugin/test`, for a mutation of a fake's fidelity) at the head that carries
# it, so every kill count in a commit body or a PR body is reproducible by a
# stranger with one command and no guessing about what the prose meant (review
# round 2, finding 7). The output is TAP: every `not ok` line names a test the
# mutant killed, and their number IS the kill count.
#
# EXACT, NEVER FUZZY. `-F0` refuses to apply a hunk whose context has moved:
# a patch that no longer describes the code it was written for must fail loudly
# rather than land two functions away and be counted as a mutation of something
# it never touched.
#
# THE TREE IS RESTORED FROM A COPY, NEVER FROM GIT. `git checkout -- plugin`
# would erase uncommitted work belonging to whoever is running this, so both
# trees are copied out first, copied back on every exit path including an
# interrupt, verified against that copy, and rebuilt -- a restored source over
# a mutated `build/` is still a mutated suite. A mutation tool that can leave a
# mutant behind is a worse defect than the one it is hunting.
set -eu

patch_file="${1:?usage: run.sh <mutant.diff>}"
root="$(cd "$(dirname "$0")/../../.." && pwd)"
pristine="$(mktemp -d)"

for tree in src test; do
  mkdir -p "${pristine}/${tree}"
  cp -R "${root}/plugin/${tree}/." "${pristine}/${tree}/"
done

restore() {
  status=$?
  for tree in src test; do
    find "${root}/plugin/${tree}" -name '*.orig' -o -name '*.rej' -exec rm -f {} +
    cp -R "${pristine}/${tree}/." "${root}/plugin/${tree}/"
    if ! diff -r -q "${pristine}/${tree}" "${root}/plugin/${tree}" >/dev/null; then
      printf 'MUTANT LEFT IN THE TREE: restore plugin/%s from %s by hand\n' "${tree}" "${pristine}" >&2
      exit 2
    fi
  done
  rm -rf "${pristine}"
  (cd "${root}/plugin" && npm run build >/dev/null)
  exit "${status}"
}
trap restore EXIT INT TERM

printf '=== %s ===\n' "$(basename "${patch_file}")"
if ! patch -s -F0 -p1 -d "${root}" <"${patch_file}"; then
  printf 'PATCH DOES NOT APPLY: this mutant no longer describes this head\n'
  exit 0
fi
cd "${root}/plugin"
if ! npm run build >/dev/null 2>&1; then
  printf 'COMPILE ERROR: this mutant is not behavioural, and is not a kill\n'
  exit 0
fi
node --test --test-reporter=tap test/*.test.mjs 2>&1 |
  grep -E '^(not ok|# (pass|fail) )' || true
