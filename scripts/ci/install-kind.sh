#!/usr/bin/env bash
# Install the exact pinned `kind` with a SHA-256-verified download, outside the
# checkout so the tree scanners never scan the scanner.
#
# Requirement 5 admits CI tooling because it ships nothing -- but only when it
# is "pinned by version and checksum". `scripts/ci/install-tools.sh` is the
# same argument for the tools every gate job needs; kind is here instead of
# there because exactly one job needs it, and a 10 MiB download in three jobs
# that never create a cluster is a tax with no payer.
#
# BOTH CHECKSUMS BELOW WERE TAKEN FROM THE PUBLISHER'S OWN CHECKSUM FILES, over
# HTTPS, on 2026-09-20, and each URL is recorded beside its pin so the next
# reader can repeat the check in one command instead of trusting this comment:
#
#   kind amd64  https://github.com/kubernetes-sigs/kind/releases/download/v0.33.0/kind-linux-amd64.sha256sum
#   kind arm64  https://github.com/kubernetes-sigs/kind/releases/download/v0.33.0/kind-linux-arm64.sha256sum
#
# THE NODE IMAGE IS A PIN TOO, and a digest rather than a tag: kind's own
# release notes say the `@sha256` reference is the only way to get an image
# built for this release. v1.37.0 satisfies the chart's `kubeVersion: >=1.36.0`
# without being the newest thing that happens to exist on the day a job runs.
# `scripts/ci/helm-e2e.sh` reads both the version and the node image out of
# THIS file, so the pin is one fact with two readers.
set -euo pipefail

KIND_VERSION=v0.33.0
KIND_SHA256_AMD64=aee6151561422756b764a4ae28e7f44cda5af5a9eead3cc9985112b1de8d8e0d
KIND_SHA256_ARM64=20022bee6cfcd5086cb7234d218e3454e6090022f2a8f55d1fa7fcf42c3867a2
KIND_NODE_IMAGE=kindest/node:v1.37.0@sha256:a1ed56cfb0e7b93589bdf97c8cd566405a265939e3620fc4f5de89adff580ae5

: "${RUNNER_TEMP:?GitHub Actions must provide RUNNER_TEMP}"
install_root="$(mktemp -d "${RUNNER_TEMP%/}/obsync-kind.XXXXXX")"
download_root="$(mktemp -d "${RUNNER_TEMP%/}/obsync-kind-downloads.XXXXXX")"
trap 'rm -rf -- "${download_root}"' EXIT

case "$(uname -m)" in
  x86_64 | amd64) architecture=amd64; sha="${KIND_SHA256_AMD64}" ;;
  aarch64 | arm64) architecture=arm64; sha="${KIND_SHA256_ARM64}" ;;
  *)
    printf 'install-kind: unsupported architecture %s\n' "$(uname -m)" >&2
    exit 1
    ;;
esac

curl --proto '=https' --tlsv1.2 -sSfL \
  "https://github.com/kubernetes-sigs/kind/releases/download/${KIND_VERSION}/kind-linux-${architecture}" \
  -o "${download_root}/kind"
printf '%s  %s\n' "${sha}" "${download_root}/kind" | sha256sum -c - >/dev/null
install -m 0755 "${download_root}/kind" "${install_root}/kind"

echo "${install_root}" >> "${GITHUB_PATH}"

# Assert the installed VERSION, not merely that a binary exists: the checksum
# proves which bytes arrived, and this proves those bytes are the tool the
# workflow believes it is running.
test "$("${install_root}/kind" version --quiet)" = "${KIND_VERSION#v}"
printf 'pinned CI tool installed: kind %s (%s), node image %s\n' \
  "${KIND_VERSION}" "${architecture}" "${KIND_NODE_IMAGE}"
