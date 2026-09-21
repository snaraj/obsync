#!/usr/bin/env bash
# distro-smoke -- run the SHIPPED binary on a Linux distribution that is not
# the one it was built on, and prove it loads and serves there.
#
# WHY THIS EXISTS. Requirement 14 says the server runs on linux/amd64 and
# linux/arm64 as a static binary. The Dockerfile makes that true by building
# against musl with `+crt-static` and self-contained linking, and the gate
# asserts the ELF is statically linked -- on the runner, with `file`. What
# neither proves is that the result RUNS somewhere else: a static claim is a
# property of the header, and "it starts on Alpine" is a property of the
# kernel interface, the ELF loader and whatever the distribution does to a
# binary it did not package.
#
# There is therefore NO glibc floor to document. The binary links no libc at
# all -- musl is inside it -- so Debian, Ubuntu, Fedora and Alpine are the same
# execution environment to it, and the matrix that runs this script proves
# exactly that rather than asserting it. A future move to a glibc target would
# make Alpine fail here first, which is the point.
#
# WHAT IT PROVES, per distribution image:
#
#   1. it loads   `obsyncd version` prints this repository's VERSION. The ELF
#                 was mapped and its entry point ran: no interpreter, no
#                 missing shared object, no `exec format error`.
#   2. it serves  `obsyncd serve` reaches `{"ready":true` on a published
#                 loopback port within the stated budget, having created and
#                 opened both volume directories.
#   3. teardown   the container is removed, from a trap, so a failure at
#                 either step above leaves nothing behind on the runner.
#
# WHAT IT DOES NOT PROVE, stated rather than implied: the runtime uid and the
# volume ownership posture, which are `scripts/ci/image-smoke.sh` properties 2
# and 8 on the real image. This container runs as root on its own writable
# layer on purpose -- a distribution image ships no prepared /data and no user
# 65532, and inventing both here would test this script rather than the binary.
#
# The distribution image must be pinned by digest: a tag would make the answer
# to "does it run on Debian" depend on the day the job ran.
#
# Requires: docker, curl.
set -euo pipefail

usage() {
  printf 'usage: %s <path to obsyncd> <distribution image@sha256:…>\n' "${0##*/}" >&2
  printf '  Runs that binary inside that image and proves it serves.\n' >&2
}

if [ "$#" -ne 2 ] || [ -z "${1:-}" ] || [ -z "${2:-}" ]; then
  usage
  exit 2
fi
binary="$1"
image="$2"

here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "${here}/../.." && pwd)"
readonly PORT=18280
readonly READY_BUDGET_SECONDS=60
readonly BLOBS_CAPACITY='1GiB'
readonly JOURNAL_CAPACITY='256MiB'
readonly PULL_ATTEMPTS=3
readonly PULL_BACKOFF_SECONDS=5

container="obsync-distro-$$-${RANDOM}"
scratch="$(mktemp -d "${TMPDIR:-/tmp}/distro-smoke.XXXXXX")"
started_at="$(date +%s)"

proven=0
prove() {
  proven=$((proven + 1))
  printf 'distro-smoke: (%d) %s\n' "${proven}" "$1"
}

deny() {
  printf 'distro-smoke: DENY %s\n' "$1" >&2
  if docker container inspect "${container}" >/dev/null 2>&1; then
    printf 'distro-smoke: --- container logs ---\n' >&2
    docker logs "${container}" >&2 2>&1 || true
    docker container inspect --format \
      'status={{.State.Status}} exit={{.State.ExitCode}} error={{.State.Error}}' \
      "${container}" >&2 || true
  fi
  exit 1
}

cleanup() {
  local status=$?
  docker rm --force "${container}" >/dev/null 2>&1 || true
  rm -rf -- "${scratch}"
  return "${status}"
}
trap cleanup EXIT

case "${image}" in
  *@sha256:*) ;;
  *) deny "the distribution image ${image} is not pinned by digest" ;;
esac
[ -f "${binary}" ] || deny "no binary at ${binary}; this script builds nothing"
case "${binary}" in
  /*) ;;
  *) binary="$(cd "$(dirname "${binary}")" && pwd)/$(basename "${binary}")" ;;
esac
version="$(tr -d '[:space:]' < "${root}/VERSION")"

printf 'distro-smoke: START image=%s binary=%s version=%s ready_budget=%ds\n' \
  "${image}" "${binary}" "${version}" "${READY_BUDGET_SECONDS}"

# The distribution image is fetched anonymously and BY DIGEST, retried with
# backoff, so a registry hiccup on a runner reads as a registry failure and
# never as an obsync defect.
pulled=''
for attempt in $(seq 1 "${PULL_ATTEMPTS}"); do
  if docker image inspect "${image}" >/dev/null 2>&1; then
    pulled='cached'
    break
  fi
  if docker pull --quiet "${image}" >/dev/null 2>&1; then
    pulled="attempt ${attempt}"
    break
  fi
  printf 'distro-smoke: pull attempt %d/%d failed for %s; retrying in %ds\n' \
    "${attempt}" "${PULL_ATTEMPTS}" "${image}" "${PULL_BACKOFF_SECONDS}" >&2
  sleep "${PULL_BACKOFF_SECONDS}"
done
[ -n "${pulled}" ] \
  || deny "could not pull ${image} in ${PULL_ATTEMPTS} attempts; this is a registry failure, not an obsync one"

# (1) The ELF loads on this distribution. Standard error goes to a file rather
# than into the answer: a pull line or a warning on the way past would
# otherwise become part of what this compares.
reported="$(docker run --rm --network none \
  --volume "${binary}:/obsyncd:ro" "${image}" /obsyncd version 2>"${scratch}/version.err")" \
  || deny "the binary would not run on ${image}: $(tr '\n' ' ' < "${scratch}/version.err")"
[ "${reported}" = "obsyncd ${version}" ] \
  || deny "the binary on ${image} reported '${reported}', not 'obsyncd ${version}'"
prove "it loads (${pulled}): ${image} ran the binary and it reported ${reported}"

# (2) It serves. The data directories are created in the container's own
# writable layer, because a distribution image ships none.
docker run --detach --name "${container}" \
  --publish "127.0.0.1:${PORT}:8080" \
  --volume "${binary}:/obsyncd:ro" \
  --env "OBSYNC_BLOBS_CAPACITY=${BLOBS_CAPACITY}" \
  --env "OBSYNC_JOURNAL_CAPACITY=${JOURNAL_CAPACITY}" \
  "${image}" \
  /bin/sh -c 'mkdir -p /data/blobs /data/journal && chmod 700 /data/blobs /data/journal && exec /obsyncd serve' \
  >/dev/null \
  || deny "could not start the binary under ${image}"
ready=''
for _ in $(seq 1 "${READY_BUDGET_SECONDS}"); do
  state="$(docker container inspect --format '{{.State.Status}}' "${container}" 2>/dev/null || true)"
  [ "${state}" = running ] || deny "the container is ${state:-gone} before the server was ready"
  body="$(curl --silent --show-error --max-time 3 \
    "http://127.0.0.1:${PORT}/readyz" 2>/dev/null || true)"
  case "${body}" in
    '{"ready":true'*)
      ready="${body}"
      break
      ;;
  esac
  sleep 1
done
[ -n "${ready}" ] \
  || deny "no {\"ready\":true from the server running under ${image} within ${READY_BUDGET_SECONDS}s"
prove "it serves: /readyz answered ${ready} from the binary running under ${image}"

# (3) Teardown, proven rather than assumed.
docker rm --force "${container}" >/dev/null 2>&1 \
  || deny "could not remove ${container}"
if docker container inspect "${container}" >/dev/null 2>&1; then
  deny "${container} survived removal"
fi
prove "teardown: ${container} is gone"

printf 'distro-smoke: SUMMARY image=%s version=%s steps=%d duration=%ds decision=pass\n' \
  "${image}" "${version}" "${proven}" "$(( $(date +%s) - started_at ))"
