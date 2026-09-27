#!/usr/bin/env bash
# chart-kube-versions -- render the chart for every Kubernetes version its
# `kubeVersion` claims, in the spellings real clusters report, and refuse the
# version just below the floor.
#
# WHY. The PR gate renders the chart for exactly one version, v1.36.0. What a
# managed cluster reports is rarely that clean: EKS says `v1.36.3-eks-…`, GKE
# `v1.36.3-gke.…`, k3s `v1.36.3+k3s1`. Semantic versioning reads the first two
# as PRE-RELEASES, which a constraint without a `-0` suffix excludes, so a
# chart claiming ">=1.36.0" refuses a cluster that is plainly 1.36. This makes
# the claim and the clusters it names meet, and the negative leg proves the
# floor is enforced at all -- a constraint helm ignored would pass every other
# line here.
#
# Requires: helm (scripts/ci/install-tools.sh pins it).
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "${here}/../.." && pwd)"
chart="${root}/chart"

# The floor the chart states, and the newest version this repository runs a
# cluster at (the kind node image pinned in install-kind.sh).
floor="$(awk -F'"' '/^kubeVersion:/{print $2}' "${chart}/Chart.yaml" | sed -E 's/^>=[[:space:]]*v?//; s/-0$//')"
newest="$(awk -F= '/^KIND_NODE_IMAGE=/{print $2}' "${here}/install-kind.sh" | sed -E 's/^[^:]*:v?([0-9.]+)@.*/\1/')"
case "${floor}" in
  [0-9]*.[0-9]*.[0-9]*) ;;
  *) printf 'chart-kube-versions: DENY cannot read a >=X.Y.Z floor from chart/Chart.yaml (read %s)\n' "${floor:-nothing}" >&2; exit 1 ;;
esac
IFS=. read -r major minor _ <<<"${floor}"
IFS=. read -r newest_major newest_minor _ <<<"${newest}"
below="v${major}.$((minor - 1)).9"

printf 'chart-kube-versions: START floor=%s newest=%s below=%s\n' "${floor}" "${newest}" "${below}"

failed=0
render() {
  local version="$1" want="$2" output
  if output="$(helm template smoke "${chart}" --kube-version "${version}" 2>&1 >/dev/null)"; then
    got=renders
  else
    got=refused
  fi
  if [ "${got}" = "${want}" ]; then
    printf 'chart-kube-versions: %-26s %s, as it must\n' "${version}" "${got}"
  else
    printf 'chart-kube-versions: DENY %s %s where it must be %s: %s\n' "${version}" "${got}" "${want}" "${output}" >&2
    failed=1
  fi
}

for minor_now in $(seq "${minor}" "${newest_minor}"); do
  [ "${major}" = "${newest_major}" ] || break
  render "v${major}.${minor_now}.0" renders
  render "v${major}.${minor_now}.3-eks-1a2b3c4" renders
  render "v${major}.${minor_now}.3-gke.1200000" renders
  render "v${major}.${minor_now}.3+k3s1" renders
done
render "${below}" refused

if [ "${failed}" -ne 0 ]; then
  printf 'chart-kube-versions: SUMMARY decision=deny\n' >&2
  exit 1
fi
printf 'chart-kube-versions: SUMMARY decision=pass\n'
