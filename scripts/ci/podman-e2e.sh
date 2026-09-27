#!/usr/bin/env bash
# podman-e2e -- the Compose deployment under ROOTLESS Podman: the same
# deploy/compose/docker-compose.yml, run by an unprivileged user through
# `podman compose`, published on 8080/8443 because an unprivileged user cannot
# bind 80 and 443.
#
# WHY. docs/server.md shows Docker. Podman is what Fedora, RHEL and many
# hardened hosts run instead, usually rootless, and rootless changes two things
# a Compose file can trip on: nothing below port 1024 can be published, and
# every uid inside a container -- 65532 included -- is a subordinate uid on the
# host. The review that asked for this (M3) found neither ever run.
#
# WHAT IT PROVES:
#   1. preflight   not root; the host's unprivileged port floor (so the 80/443
#                  refusal is a fact about this host, stated); podman; a
#                  Compose provider for `podman compose`; the image loaded.
#   2. the service podman's own API socket, started by this user, in scratch.
#   3. up          `podman compose up -d` on the unmodified compose file, with
#                  OBSYNC_HTTP_PORT=8080 and OBSYNC_HTTPS_PORT=8443.
#   4. readiness   `/readyz` through Caddy over TLS against the root Caddy
#                  made, copied out with `podman cp`.
#   5. it syncs    `api_flow.py enroll` with the token `obsyncd setup-token`
#                  prints inside the running container.
#   6. a restart   `podman compose restart`, then `api_flow.py verify`.
#   7. teardown    `podman compose down --volumes`, the service stopped.
#
# Requires: podman, a Compose provider (the Docker Compose v2 plugin on the CI
# runner), curl, python3. The image is a `docker save` archive or already in
# this user's podman storage.
set -euo pipefail

usage() {
  printf 'usage: %s <obsync-image-reference> [<image-archive.tar>]\n' "${0##*/}" >&2
}
if [ "$#" -lt 1 ] || [ "$#" -gt 2 ] || [ -z "${1:-}" ]; then
  usage
  exit 2
fi
image="$1"
archive="${2:-}"

here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "${here}/../.." && pwd)"
readonly COMPOSE_FILE="${root}/deploy/compose/docker-compose.yml"
run_id="$(printf '%s' "${OBSYNC_E2E_RUN_ID:-$$-${RANDOM}}" | tr -c '[:alnum:]_-' '-')"
readonly PROJECT="obsync-e2e-${run_id}"
readonly OBSYNC_CONTAINER="${PROJECT}-obsync-1"
readonly CADDY_CONTAINER="${PROJECT}-caddy-1"
readonly HOST='obsync-podman.invalid'
readonly HTTP_PORT=8080
readonly HTTPS_PORT=8443
readonly READY_BUDGET_SECONDS=120

scratch="$(mktemp -d "${TMPDIR:-/tmp}/podman-e2e.XXXXXX")"
service_pid=''
created=''
started_at="$(date +%s)"
step_at="${started_at}"

proven=0
prove() {
  local now
  now="$(date +%s)"
  proven=$((proven + 1))
  printf 'podman-e2e: (%d) %s [%ds]\n' "${proven}" "$1" "$((now - step_at))"
  step_at="${now}"
}

compose() {
  podman compose --project-name "${PROJECT}" --file "${COMPOSE_FILE}" "$@"
}

deny() {
  printf 'podman-e2e: DENY %s\n' "$1" >&2
  if [ -n "${created}" ]; then
    podman ps --all >&2 2>&1 || true
    for name in "${OBSYNC_CONTAINER}" "${CADDY_CONTAINER}"; do
      podman logs --tail 30 "${name}" >&2 2>&1 || true
    done
  fi
  exit 1
}

cleanup() {
  local status=$?
  if [ -n "${created}" ]; then
    compose down --volumes --remove-orphans >/dev/null 2>&1 || true
  fi
  if [ -n "${service_pid}" ]; then
    kill "${service_pid}" >/dev/null 2>&1 || true
    wait "${service_pid}" 2>/dev/null || true
  fi
  rm -rf -- "${scratch}"
  return "${status}"
}

export OBSYNC_IMAGE="${image}" OBSYNC_HOST="${HOST}" OBSYNC_BIND_ADDRESS=127.0.0.1
export OBSYNC_HTTP_PORT="${HTTP_PORT}" OBSYNC_HTTPS_PORT="${HTTPS_PORT}"
export OBSYNC_BLOBS_CAPACITY=8GiB OBSYNC_JOURNAL_CAPACITY=4GiB

printf 'podman-e2e: START image=%s project=%s host=%s ports=%d,%d\n' \
  "${image}" "${PROJECT}" "${HOST}" "${HTTP_PORT}" "${HTTPS_PORT}"

# (1) Preflight.
[ "$(id -u)" -ne 0 ] || deny 'this run proves ROOTLESS Podman and must not run as root'
floor="$(cat /proc/sys/net/ipv4/ip_unprivileged_port_start)"
command -v podman >/dev/null 2>&1 || deny 'podman is not installed; this script installs nothing'
# `podman compose` hands the file to a Compose provider. The runner carries
# the Docker Compose v2 plugin; name it explicitly so the run never depends on
# which provider a PATH search happens to find first.
if [ -z "${PODMAN_COMPOSE_PROVIDER:-}" ]; then
  for candidate in /usr/libexec/docker/cli-plugins/docker-compose /usr/local/lib/docker/cli-plugins/docker-compose \
    /usr/lib/docker/cli-plugins/docker-compose; do
    [ -x "${candidate}" ] && export PODMAN_COMPOSE_PROVIDER="${candidate}" && break
  done
fi
[ -n "${PODMAN_COMPOSE_PROVIDER:-}" ] || deny 'no Compose provider for podman compose'
if [ -n "${archive}" ]; then
  podman load --quiet --input "${archive}" >/dev/null || deny "podman could not load ${archive}"
fi
podman image exists "${image}" || deny "podman holds no image ${image}"
! podman container exists "${OBSYNC_CONTAINER}" || deny "${OBSYNC_CONTAINER} already exists"
# Name resolution between the two containers is the network backend's DNS
# (netavark with aardvark-dns). Without it Caddy cannot find `obsync` and
# every request is a 502; the backend is logged so that failure reads plainly.
backend="$(podman info --format '{{.Host.NetworkBackend}}' 2>/dev/null || true)"
prove "preflight: uid $(id -u), unprivileged ports from ${floor} on this host, publishing ${HTTP_PORT}/${HTTPS_PORT}, $(podman --version), network ${backend:-unknown}, provider ${PODMAN_COMPOSE_PROVIDER##*/}"

trap cleanup EXIT

# (2) Podman's API socket, which is what a Compose provider talks to.
socket="${scratch}/podman.sock"
podman system service --time=0 "unix://${socket}" >"${scratch}/service.log" 2>&1 &
service_pid=$!
for _ in $(seq 1 30); do
  [ -S "${socket}" ] && break
  sleep 1
done
[ -S "${socket}" ] || { cat "${scratch}/service.log" >&2; deny 'the podman API service did not start'; }
export DOCKER_HOST="unix://${socket}"
export CONTAINER_HOST="unix://${socket}"
prove "the service: podman's API socket is up for this user"

# (3) The compose file, unmodified.
created='project'
compose up -d >"${scratch}/up.log" 2>&1 || { cat "${scratch}/up.log" >&2; deny 'podman compose up failed'; }
prove "up: ${OBSYNC_CONTAINER} and ${CADDY_CONTAINER} from deploy/compose/docker-compose.yml, rootless"

# (4) Readiness through Caddy.
ready=''
for _ in $(seq 1 "${READY_BUDGET_SECONDS}"); do
  if [ ! -s "${scratch}/root.crt" ]; then
    podman cp "${CADDY_CONTAINER}:/data/caddy/pki/authorities/local/root.crt" "${scratch}/root.crt" >/dev/null 2>&1 || true
  fi
  if [ -s "${scratch}/root.crt" ]; then
    body="$(curl --silent --max-time 3 --cacert "${scratch}/root.crt" \
      --resolve "${HOST}:${HTTPS_PORT}:127.0.0.1" "https://${HOST}:${HTTPS_PORT}/readyz" 2>/dev/null || true)"
    case "${body}" in '{"ready":true'*) ready="${body}"; break ;; esac
  fi
  sleep 1
done
[ -n "${ready}" ] || deny "no {\"ready\":true through Caddy on ${HTTPS_PORT} within ${READY_BUDGET_SECONDS}s"
prove "readiness: /readyz answered ${ready} through Caddy on 127.0.0.1:${HTTPS_PORT}"

# (5) The token, by the server's own verb, and the sync flow.
umask 077
podman exec "${OBSYNC_CONTAINER}" /usr/local/bin/obsyncd setup-token | tr -d '[:space:]' > "${scratch}/token" \
  || deny 'the server would not print its setup token'
umask 022
if [ -n "${GITHUB_ACTIONS:-}" ]; then
  printf '::add-mask::%s\n' "$(cat "${scratch}/token")"
fi
python3 -B "${here}/api_flow.py" enroll --host "${HOST}" --port "${HTTPS_PORT}" --address 127.0.0.1 \
  --cacert "${scratch}/root.crt" --state "${scratch}/devices.json" < "${scratch}/token" \
  || deny 'the sync flow failed on rootless Podman'
prove 'it syncs: first boot, pairing, one file each way and four refusals'

# (6) A restart keeps everything.
compose restart >/dev/null 2>&1 || deny 'podman compose restart failed'
ready=''
for _ in $(seq 1 "${READY_BUDGET_SECONDS}"); do
  body="$(curl --silent --max-time 3 --cacert "${scratch}/root.crt" \
    --resolve "${HOST}:${HTTPS_PORT}:127.0.0.1" "https://${HOST}:${HTTPS_PORT}/readyz" 2>/dev/null || true)"
  case "${body}" in '{"ready":true'*) ready="${body}"; break ;; esac
  sleep 1
done
[ -n "${ready}" ] || deny 'the deployment did not come back after the restart'
python3 -B "${here}/api_flow.py" verify --host "${HOST}" --port "${HTTPS_PORT}" --address 127.0.0.1 \
  --cacert "${scratch}/root.crt" --state "${scratch}/devices.json" \
  || deny 'the restarted deployment lost the account, the devices or the data'
prove 'a restart: both devices, the file and the spent nonce came back'

# (7) Teardown.
compose down --volumes --remove-orphans >/dev/null 2>&1 || deny 'podman compose down failed'
created=''
prove "teardown: project ${PROJECT} is gone, volumes included"
printf 'podman-e2e: SUMMARY image=%s steps=%d duration=%ds decision=pass\n' \
  "${image}" "${proven}" "$(( $(date +%s) - started_at ))"
