#!/bin/sh
# Run every mutant beside this script, in order, and print one section each.
#
#   plugin/test/mutants/matrix.sh                 # the whole matrix
#   plugin/test/mutants/matrix.sh M16 M17         # a subset, by id
#
# The result is the kill matrix: for each mutant, every `not ok` line names a
# test that killed it, and `# fail` is the count. `run.sh` restores and rebuilds
# the tree after each one, and one mutant that cannot be applied or built does
# not end the run -- a matrix that stops halfway hides the rest of itself.
set -u

here="$(cd "$(dirname "$0")" && pwd)"
if [ "$#" -gt 0 ]; then
  for id in "$@"; do sh "${here}/run.sh" "${here}/${id}.diff" || printf 'RUNNER FAILED: %s\n' "${id}"; done
else
  for patch in "${here}"/M*.diff; do
    sh "${here}/run.sh" "${patch}" || printf 'RUNNER FAILED: %s\n' "$(basename "${patch}")"
  done
fi
