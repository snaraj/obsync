#!/usr/bin/env bash
# Install the exact pinned `k3d` with a SHA-256-verified download, outside the
# checkout, for the one job that runs a k3s cluster (scripts/ci/k3d-e2e.sh).
#
# It is a sibling of install-kind.sh rather than a line in it for the reason
# that file gives about kind: one job needs it, and a download in jobs that
# never create a cluster is a tax with no payer.
#
# BOTH CHECKSUMS BELOW ARE THE PUBLISHER'S OWN, from
#   https://github.com/k3d-io/k3d/releases/download/v5.9.0/checksums.txt
# read over HTTPS on 2026-09-26, and equal to the digests GitHub records for
# the two release assets.
#
# THE k3s IMAGE IS A PIN TOO, by index digest: v1.36.4+k3s1, the chart's
# `kubeVersion` floor minor, so the kind legs (v1.37) and this one (v1.36)
# between them cover the range the chart claims. k3s brings its own Traefik,
# local-path provisioner and network-policy controller at the versions that
# release names; those three are what this run exists to exercise.
# `scripts/ci/k3d-e2e.sh` reads the image out of THIS file.
set -euo pipefail

K3D_VERSION=v5.9.0
K3D_SHA256_AMD64=06d8f25bc3a971c4eb29e0ff08429b180402db0f4dec838c9eac427e296800a0
K3D_SHA256_ARM64=03cde5cf23e6e8e67de5a039ecf26e5b85aca82fba3e5d13dadf904cd218a250
K3S_IMAGE=docker.io/rancher/k3s:v1.36.4-k3s1@sha256:edad48e12bf81c3a09ac1c05c0c0ffaaa22145980b989d6fae84543a76b83657

: "${RUNNER_TEMP:?GitHub Actions must provide RUNNER_TEMP}"
install_root="$(mktemp -d "${RUNNER_TEMP%/}/obsync-k3d.XXXXXX")"
download_root="$(mktemp -d "${RUNNER_TEMP%/}/obsync-k3d-downloads.XXXXXX")"
trap 'rm -rf -- "${download_root}"' EXIT

case "$(uname -m)" in
  x86_64 | amd64) architecture=amd64; sha="${K3D_SHA256_AMD64}" ;;
  aarch64 | arm64) architecture=arm64; sha="${K3D_SHA256_ARM64}" ;;
  *)
    printf 'install-k3d: unsupported architecture %s\n' "$(uname -m)" >&2
    exit 1
    ;;
esac

curl --proto '=https' --tlsv1.2 -sSfL \
  "https://github.com/k3d-io/k3d/releases/download/${K3D_VERSION}/k3d-linux-${architecture}" \
  -o "${download_root}/k3d"
printf '%s  %s\n' "${sha}" "${download_root}/k3d" | sha256sum -c - >/dev/null
install -m 0755 "${download_root}/k3d" "${install_root}/k3d"

echo "${install_root}" >> "${GITHUB_PATH}"

"${install_root}/k3d" version | grep -qx "k3d version ${K3D_VERSION}"
printf 'pinned CI tool installed: k3d %s (%s), k3s image %s\n' "${K3D_VERSION}" "${architecture}" "${K3S_IMAGE}"
