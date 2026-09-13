#!/usr/bin/env bash
# Verify exported bytes locally before publication, or downloaded bytes in the
# read-only audit. GitHub's immutable-release predicate is not build provenance.
# Exact certificate identity includes repository, workflow and main ref. gh
# makes it mutually exclusive with the broader --signer-workflow selector.
set -euo pipefail
directory="${1:?native plugin directory required}"
source_sha="${2:?authorized source SHA required}"
[[ "${source_sha}" =~ ^[0-9a-f]{40}$ ]]
test "${GITHUB_REPOSITORY}" = snaraj/obsync
bundle_args=()
if [ "$#" -eq 3 ]; then
  test -s "$3"
  bundle_args=(--bundle "$3")
fi
for member in main.js manifest.json styles.css; do
  gh attestation verify "${directory}/${member}" \
    --repo "${GITHUB_REPOSITORY}" \
    --cert-identity 'https://github.com/snaraj/obsync/.github/workflows/release-publisher.yml@refs/heads/main' \
    --cert-oidc-issuer 'https://token.actions.githubusercontent.com' \
    --source-ref refs/heads/main --source-digest "${source_sha}" \
    --signer-digest "${source_sha}" --deny-self-hosted-runners \
    --predicate-type https://slsa.dev/provenance/v1 "${bundle_args[@]}"
done
