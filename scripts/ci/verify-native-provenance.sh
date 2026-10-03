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
# The server archives, from 1.1.4 on, are named by the caller: the publisher's
# own export, or the audit's download of each archive the evidence records.
read -r -a archives <<< "${SERVER_ARCHIVES:-}"
if [ -n "${CLI_ARCHIVES:-}" ]; then
  for platform in linux-amd64 linux-arm64 darwin-arm64 windows-amd64; do
    selected=("${CLI_ARCHIVES}"/obsync-cli-*-${platform}.zip)
    test "${#selected[@]}" -eq 1 && test -f "${selected[0]}"
    archives+=("${selected[0]}")
  done
fi
for member in "${directory}/main.js" "${directory}/manifest.json" "${directory}/styles.css" \
  "${archives[@]}"; do
  gh attestation verify "${member}" \
    --repo "${GITHUB_REPOSITORY}" \
    --cert-identity 'https://github.com/snaraj/obsync/.github/workflows/release-publisher.yml@refs/heads/main' \
    --cert-oidc-issuer 'https://token.actions.githubusercontent.com' \
    --source-ref refs/heads/main --source-digest "${source_sha}" \
    --signer-digest "${source_sha}" --deny-self-hosted-runners \
    --predicate-type https://slsa.dev/provenance/v1 "${bundle_args[@]}"
done
