#!/usr/bin/env bash
# Install the exact pinned CI tools with SHA-256-verified downloads, outside
# the checkout so the tree scanners never scan the scanners.
#
# Requirement 5 admits CI tooling because it ships nothing -- but only when it
# is "pinned by version and checksum". That is what this file is. There is no
# `latest`, no installer script piped to a shell, and no third-party setup
# action in this path: every artifact is one reviewed archive URL and one
# repository-owned SHA-256 lock, so a compromised release tag cannot silently
# substitute bytes. That is not hypothetical -- the Trivy action ecosystem
# suffered a 2026 tag/Release compromise, which is exactly why the scanner
# below comes from the immutable release archive rather than from an action.
#
# EVERY CHECKSUM BELOW WAS TAKEN FROM THE PUBLISHER'S OWN CHECKSUM FILE, over
# HTTPS, on 2026-09-07, and each URL is recorded beside its pin so the next
# reader can repeat the check in one command instead of trusting this comment:
#
#   gitleaks   https://github.com/gitleaks/gitleaks/releases/download/v8.30.1/gitleaks_8.30.1_checksums.txt
#   helm       https://get.helm.sh/helm-v3.19.2-linux-amd64.tar.gz.sha256sum
#   trivy      https://github.com/aquasecurity/trivy/releases/download/v0.72.0/trivy_0.72.0_checksums.txt
#   cosign     https://github.com/sigstore/cosign/releases/download/v3.1.3/cosign_checksums.txt
#   actionlint https://github.com/rhysd/actionlint/releases/download/v1.7.12/actionlint_1.7.12_checksums.txt
set -euo pipefail

GITLEAKS_VERSION=v8.30.1
GITLEAKS_SHA256=551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb
HELM_VERSION=v3.19.2
HELM_SHA256=2114c9dea2844dce6d0ee2d792a9aae846be8cf53d5b19dc2988b5a0e8fec26e
TRIVY_VERSION=v0.72.0
TRIVY_SHA256=bbb64b9695866ce4a7a8f5c9592002c5961cab378577fa3f8a040df362b9b2ea
COSIGN_VERSION=v3.1.3
COSIGN_SHA256=4629c757b7618056f8ddd7e2625ae9fdd94c0372a65049520bc7d9df9efc7f71
ACTIONLINT_VERSION=v1.7.12
ACTIONLINT_SHA256=8aca8db96f1b94770f1b0d72b6dddcb1ebb8123cb3712530b08cc387b349a3d8

: "${RUNNER_TEMP:?GitHub Actions must provide RUNNER_TEMP}"
install_root="$(mktemp -d "${RUNNER_TEMP%/}/obsync-ci-tools.XXXXXX")"
download_root="$(mktemp -d "${RUNNER_TEMP%/}/obsync-ci-downloads.XXXXXX")"
trap 'rm -rf -- "${download_root}"' EXIT

fetch_verify() {
  local url="$1" sha="$2" out="$3"
  curl --proto '=https' --tlsv1.2 -sSfL "${url}" -o "${out}"
  printf '%s  %s\n' "${sha}" "${out}" | sha256sum -c - >/dev/null
}

fetch_verify \
  "https://github.com/gitleaks/gitleaks/releases/download/${GITLEAKS_VERSION}/gitleaks_${GITLEAKS_VERSION#v}_linux_x64.tar.gz" \
  "${GITLEAKS_SHA256}" "${download_root}/gitleaks.tar.gz"
tar -xzf "${download_root}/gitleaks.tar.gz" -C "${download_root}" gitleaks
install -m 0755 "${download_root}/gitleaks" "${install_root}/gitleaks"

fetch_verify \
  "https://get.helm.sh/helm-${HELM_VERSION}-linux-amd64.tar.gz" \
  "${HELM_SHA256}" "${download_root}/helm.tar.gz"
tar -xzf "${download_root}/helm.tar.gz" -C "${download_root}" linux-amd64/helm
install -m 0755 "${download_root}/linux-amd64/helm" "${install_root}/helm"

fetch_verify \
  "https://github.com/aquasecurity/trivy/releases/download/${TRIVY_VERSION}/trivy_${TRIVY_VERSION#v}_Linux-64bit.tar.gz" \
  "${TRIVY_SHA256}" "${download_root}/trivy.tar.gz"
tar -xzf "${download_root}/trivy.tar.gz" -C "${download_root}" trivy
install -m 0755 "${download_root}/trivy" "${install_root}/trivy"

# Straight from Sigstore's release archive rather than through
# sigstore/cosign-installer. The action would be one more third-party
# executable in the release path, and the property that matters -- these exact
# bytes -- is asserted here in one line either way.
fetch_verify \
  "https://github.com/sigstore/cosign/releases/download/${COSIGN_VERSION}/cosign-linux-amd64" \
  "${COSIGN_SHA256}" "${download_root}/cosign"
install -m 0755 "${download_root}/cosign" "${install_root}/cosign"

fetch_verify \
  "https://github.com/rhysd/actionlint/releases/download/${ACTIONLINT_VERSION}/actionlint_${ACTIONLINT_VERSION#v}_linux_amd64.tar.gz" \
  "${ACTIONLINT_SHA256}" "${download_root}/actionlint.tar.gz"
tar -xzf "${download_root}/actionlint.tar.gz" -C "${download_root}" actionlint
install -m 0755 "${download_root}/actionlint" "${install_root}/actionlint"

echo "${install_root}" >> "${GITHUB_PATH}"

# Assert the installed VERSION, not merely that a binary exists: a checksum
# proves which bytes arrived, and this proves those bytes are the tool the
# workflow believes it is running.
test "$("${install_root}/gitleaks" version)" = "${GITLEAKS_VERSION#v}"
test "$("${install_root}/helm" version --template '{{.Version}}')" = "${HELM_VERSION}"
test "$("${install_root}/trivy" --version | awk 'NR == 1 {print $2}')" = "${TRIVY_VERSION#v}"
# cosign's version banner has changed shape across majors, so this asserts the
# version STRING is present rather than parsing a field name that may move. The
# checksum above is what actually pins the bytes; this catches a pin edited on
# one line and not the other.
"${install_root}/cosign" version 2>&1 | grep -qF "${COSIGN_VERSION}"
test "$("${install_root}/actionlint" -version | head -n 1)" = "${ACTIONLINT_VERSION#v}"
printf 'pinned CI tools installed: gitleaks %s, helm %s, trivy %s, cosign %s, actionlint %s\n' \
  "${GITLEAKS_VERSION}" "${HELM_VERSION}" "${TRIVY_VERSION}" "${COSIGN_VERSION}" "${ACTIONLINT_VERSION}"
