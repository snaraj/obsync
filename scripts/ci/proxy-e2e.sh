#!/usr/bin/env bash
# proxy-e2e -- the image this commit builds, behind one of the reverse proxies
# `deploy/proxies/compose.yml` ships, and the sync path's limits through it.
#
# WHY THIS EXISTS. docs/server.md tells a reader who already runs a reverse
# proxy to put the server behind it. A proxy's defaults break the sync path
# while `/readyz` stays green: a 1 MiB body ceiling, a buffered answer, a
# 30 s server timeout, an address header appended rather than replaced.
# scripts/validation/proxy_matrix.sh proves the forwarded headers through and
# around each proxy; this run proves the LIMITS, and does it from where a
# client stands.
#
# THE STACK IS THE SHIPPED FILE. `deploy/proxies/compose.yml` with the proxy's
# profile, unmodified: the same images by digest, the same hardening, the same
# trust list naming the proxy's one address, no port on the server. The only
# addition is an override that joins the proxy to a second network, `front`,
# where the client container stands at an address this script chose -- so the
# address the server records can be checked exactly, and the server's own port
# can be asked for from somewhere that is not the proxy.
#
# WHAT IT PROVES, in order:
#
#   1. preflight   docker with compose, curl, openssl, the image, the compose
#                  file, both subnets unclaimed, nothing of this run's name
#                  standing, the published port free.
#   2. an authority  a throwaway CA and a leaf for a `.invalid` name, made
#                  here by openssl and valid for one day. Nothing on this host
#                  trusts it; only the client is told to.
#   3. the stack   `docker compose --profile <proxy> up` on the shipped file.
#   4. readiness   `/readyz` answers `{"ready":true` through the proxy over TLS.
#   5. it syncs    `api_flow.py enroll`: first boot, pairing, one file each
#                  way, the four refusals by name.
#   6. the proxy   `api_flow.py proxy`: an 8 MiB + 16 B chunk both ways, a
#      keeps out   32 MiB batch in one answer, a 55 s long poll held and one
#      of the way  woken by a write, the client's real address recorded
#                  despite a forged `X-Forwarded-For`, and the server's own
#                  port unreachable from the client's network.
#   7. teardown    `compose down --volumes`; nothing of the project remains.
#
# `--then <command>` replaces 5 and 6: the command runs while the stack is up,
# with the setup token UNSPENT in a 0600 file, and the stack is torn down after
# it. That is how the real-Obsidian run reaches a server through the Caddy leg
# without a second copy of this file.
#
# Requires: docker (with compose), curl, openssl, python3 (for nothing but a
# free-port check the shell cannot make portably).
set -euo pipefail

usage() {
  printf 'usage: %s <obsync-image-reference> <caddy|nginx|traefik|haproxy> [--then <command> [args...]]\n' "${0##*/}" >&2
}

if [ "$#" -lt 2 ] || [ -z "${1:-}" ]; then
  usage
  exit 2
fi
image="$1"
proxy="$2"
shift 2
case "${proxy}" in
  caddy | nginx | traefik | haproxy) ;;
  *)
    usage
    exit 2
    ;;
esac
then_command=()
if [ "$#" -gt 0 ]; then
  [ "$1" = --then ] && [ "$#" -ge 2 ] || { usage; exit 2; }
  shift
  then_command=("$@")
fi

here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "${here}/../.." && pwd)"
readonly COMPOSE_FILE="${root}/deploy/proxies/compose.yml"
# The client: stdlib Python only, the same api_flow.py the other runs use.
readonly CLIENT_IMAGE='docker.io/library/python:3.13-slim-trixie@sha256:7c61056e61ac89e852de05f3dc6fa51a6dd2181797bceed46aa725dd7cb2cd3b'

run_id="$(printf '%s' "${OBSYNC_E2E_RUN_ID:-$$-${RANDOM}}" | tr -c '[:alnum:]_-' '-')"
readonly PROJECT="obsync-e2e-${run_id}"
readonly SERVER="${PROJECT}-obsync-1"
readonly PROXY="${PROJECT}-${proxy}-1"
readonly FRONT="${PROJECT}_front"
# The front network is this script's; the compose file states its own subnet,
# and preflight reads it from there rather than repeating it.
readonly FRONT_SUBNET='172.31.254.248/29'
readonly PROXY_FRONT_IP='172.31.254.250'
readonly CLIENT_IP='172.31.254.251'
# Every proxy in the compose file listens here and publishes it on the host.
readonly PROXY_PORT=8443
readonly HOST='obsync-proxy.invalid'
readonly HTTPS_PORT="${OBSYNC_PROXY_HTTPS_PORT:-18643}"
readonly READY_BUDGET_SECONDS=120

created=''
started_at="$(date +%s)"
step_at="${started_at}"

proven=0
prove() {
  local now
  now="$(date +%s)"
  proven=$((proven + 1))
  printf 'proxy-e2e: (%d) %s [%ds]\n' "${proven}" "$1" "$((now - step_at))"
  step_at="${now}"
}

# The shipped file, this run's project, the proxy's profile and the one
# override. What compose interpolates is exported once below.
compose() {
  docker compose --project-name "${PROJECT}" --file "${COMPOSE_FILE}" \
    --file "${scratch}/front.yml" --profile "${proxy}" "$@"
}

deny() {
  printf 'proxy-e2e: DENY %s\n' "$1" >&2
  if [ -n "${created}" ]; then
    compose logs --tail 40 >&2 2>&1 || true
  fi
  exit 1
}

cleanup() {
  local status=$?
  if [ -n "${created}" ]; then
    compose down --volumes --remove-orphans >/dev/null 2>&1 || true
  fi
  rm -rf -- "${scratch}"
  return "${status}"
}

printf 'proxy-e2e: START image=%s proxy=%s compose=deploy/proxies/compose.yml project=%s host=%s port=%s ready_budget=%ds\n' \
  "${image}" "${proxy}" "${PROJECT}" "${HOST}" "${HTTPS_PORT}" "${READY_BUDGET_SECONDS}"

# (1) Preflight. Nothing is created until every reason not to start is refused.
for tool in docker curl openssl python3; do
  command -v "${tool}" >/dev/null 2>&1 || deny "${tool} is not installed; this script installs nothing"
done
docker compose version >/dev/null 2>&1 || deny 'docker compose is not available'
docker image inspect "${image}" >/dev/null 2>&1 || deny "no local image ${image}; this script builds nothing"
[ -f "${COMPOSE_FILE}" ] || deny "no ${COMPOSE_FILE}"
proxies_subnet="$(awk '$1 == "-" && $2 == "subnet:" {print $3; exit}' "${COMPOSE_FILE}")"
[ -n "${proxies_subnet}" ] || deny "${COMPOSE_FILE} states no subnet for its network"
for name in "${SERVER}" "${PROXY}"; do
  ! docker container inspect "${name}" >/dev/null 2>&1 || deny "a container called ${name} already exists"
done
for subnet in "${proxies_subnet}" "${FRONT_SUBNET}"; do
  holder="$(docker network ls --quiet \
    | xargs -r docker network inspect \
        --format '{{range .IPAM.Config}}{{if eq .Subnet "'"${subnet}"'"}}{{$.Name}}{{end}}{{end}}' \
    | grep -v '^$' | head -n 1 || true)"
  [ -z "${holder}" ] || deny "the docker network ${holder} already holds ${subnet}"
done
python3 -c 'import socket,sys; s=socket.socket(); s.bind(("127.0.0.1", int(sys.argv[1]))); s.close()' "${HTTPS_PORT}" 2>/dev/null \
  || deny "127.0.0.1:${HTTPS_PORT} is taken"
prove "preflight: ${image}, ${proxy} from deploy/proxies/compose.yml, ${proxies_subnet} and ${FRONT_SUBNET} unclaimed, port ${HTTPS_PORT} free"

# Made only now, with its removal armed in the same breath: a scratch made
# before the preflight was left behind by every refusal (552 of them in one
# temp folder).
scratch="$(mktemp -d "${TMPDIR:-/tmp}/proxy-e2e.XXXXXX")"
trap cleanup EXIT

# (2) A throwaway authority and a leaf for the one name the proxy serves. The
# key is readable by every uid ONLY because the proxies run as their own users
# and it is a one-day key for a name that can never resolve.
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -days 1 \
  -keyout "${scratch}/ca.key" -out "${scratch}/ca.crt" -subj '/CN=obsync e2e throwaway CA' \
  -addext 'basicConstraints=critical,CA:TRUE' -addext 'keyUsage=critical,keyCertSign' >/dev/null 2>&1 \
  || deny 'openssl could not make the throwaway authority'
mkdir -m 0755 "${scratch}/tls"
openssl req -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes \
  -keyout "${scratch}/tls/tls.key" -out "${scratch}/leaf.csr" -subj "/CN=${HOST}" >/dev/null 2>&1 \
  || deny 'openssl could not make the leaf key'
printf 'subjectAltName=DNS:%s\nextendedKeyUsage=serverAuth\n' "${HOST}" > "${scratch}/leaf.ext"
openssl x509 -req -in "${scratch}/leaf.csr" -CA "${scratch}/ca.crt" -CAkey "${scratch}/ca.key" \
  -CAcreateserial -days 1 -extfile "${scratch}/leaf.ext" -out "${scratch}/tls/tls.crt" >/dev/null 2>&1 \
  || deny 'openssl could not sign the leaf'
chmod 0644 "${scratch}/tls/"*
chmod 0755 "${scratch}"
prove "an authority: a one-day CA and a leaf for ${HOST}, trusted by nothing on this host"

# (3) The stack: the shipped file with its documented variables, and the one
# override that puts the proxy on the client's network too.
export OBSYNC_IMAGE="${image}" OBSYNC_HOST="${HOST}" OBSYNC_TLS_DIR="${scratch}/tls"
export OBSYNC_BIND_ADDRESS=127.0.0.1 OBSYNC_HTTPS_PORT="${HTTPS_PORT}"
export OBSYNC_BLOBS_CAPACITY=8GiB OBSYNC_JOURNAL_CAPACITY=4GiB
cat > "${scratch}/front.yml" <<OVERRIDE
services:
  ${proxy}:
    networks:
      front:
        ipv4_address: ${PROXY_FRONT_IP}
networks:
  front:
    ipam:
      config:
        - subnet: ${FRONT_SUBNET}
OVERRIDE
created='project'
compose up --detach >"${scratch}/up.log" 2>&1 \
  || deny "compose up failed: $(tr '\n' ' ' < "${scratch}/up.log")"
server_ip="$(docker container inspect --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "${SERVER}")" \
  || deny "compose created no container called ${SERVER}"
prove "the stack: deploy/proxies/compose.yml --profile ${proxy} as ${PROJECT}, the server at ${server_ip} with no port, ${proxy} also on ${FRONT}"

# (4) Readiness through the proxy.
ready=''
for _ in $(seq 1 "${READY_BUDGET_SECONDS}"); do
  for name in "${SERVER}" "${PROXY}"; do
    state="$(docker container inspect --format '{{.State.Status}}' "${name}" 2>/dev/null || true)"
    [ "${state}" = running ] || deny "${name} is ${state:-gone} before the deployment was ready"
  done
  body="$(curl --silent --max-time 3 --cacert "${scratch}/ca.crt" \
    --resolve "${HOST}:${HTTPS_PORT}:127.0.0.1" "https://${HOST}:${HTTPS_PORT}/readyz" 2>/dev/null || true)"
  case "${body}" in
    '{"ready":true'*) ready="${body}"; break ;;
  esac
  sleep 1
done
[ -n "${ready}" ] || deny "no {\"ready\":true through ${proxy} within ${READY_BUDGET_SECONDS}s"
prove "readiness: /readyz answered ${ready} through ${proxy} over TLS"

# The token is read by the server's own verb, in its own container: no shell,
# no tar, no copy on the host's disk but the one 0600 file below.
umask 077
docker exec "${SERVER}" /usr/local/bin/obsyncd setup-token > "${scratch}/token" 2>/dev/null \
  || deny 'the server would not print its setup token'
token="$(tr -d '[:space:]' < "${scratch}/token")"
if [ -n "${GITHUB_ACTIONS:-}" ]; then
  printf '::add-mask::%s\n' "${token}"
fi
printf '%s' "${token}" | grep -Eq '^[0-9a-f]{64}$' \
  || deny "the setup token is not 64 lowercase hex characters (${#token} read)"
printf '%s' "${token}" > "${scratch}/token"
umask 022

if [ "${#then_command[@]}" -gt 0 ]; then
  # The stack is the other command's now. What it is told: where the proxy is
  # published, the name to present, the authority to trust, and a FILE holding
  # the unspent token -- never the token in the environment. A command that
  # runs its client in a container joins `front` and uses the proxy's address
  # and port there instead of the published port.
  OBSYNC_E2E_HOST="${HOST}" OBSYNC_E2E_PORT="${HTTPS_PORT}" OBSYNC_E2E_CACERT="${scratch}/ca.crt" \
    OBSYNC_E2E_TOKEN_FILE="${scratch}/token" OBSYNC_E2E_FRONT_NETWORK="${FRONT}" \
    OBSYNC_E2E_PROXY_ADDRESS="${PROXY_FRONT_IP}" OBSYNC_E2E_PROXY_PORT="${PROXY_PORT}" "${then_command[@]}" \
    || deny "${then_command[0]} failed against the ${proxy} stack"
  prove "the stack carried ${then_command[0]##*/}"
else
  # (5) and (6), from a client on `front` with the address chosen above. The
  # token reaches it on stdin; the state file lands in this run's scratch.
  client() {
    docker run --rm --interactive --network "${FRONT}" --ip "${CLIENT_IP}" \
      --user "$(id -u):$(id -g)" --read-only --cap-drop ALL --security-opt no-new-privileges \
      --volume "${here}:/ci:ro" --volume "${scratch}:/work" \
      "${CLIENT_IMAGE}" python3 -B /ci/api_flow.py "$@" \
      --host "${HOST}" --port "${PROXY_PORT}" --address "${PROXY_FRONT_IP}" \
      --cacert /work/ca.crt --state /work/devices.json
  }
  client enroll < "${scratch}/token" || deny "the sync flow failed through ${proxy}"
  prove "it syncs: first boot, pairing, one file each way and four refusals, through ${proxy}"
  client proxy --expect-address "${CLIENT_IP}" --bypass "${server_ip}:8080" < /dev/null \
    || deny "${proxy} broke a property the sync path needs"
  prove "${proxy} keeps out of the way: the largest chunk, a full batch, a held and a woken long poll, the real client address, no way around it"
fi

# (7) Teardown, proven rather than assumed.
compose down --volumes --remove-orphans >/dev/null 2>&1 || deny "compose down failed for ${PROJECT}"
remaining="$(docker ps --all --quiet --filter "label=com.docker.compose.project=${PROJECT}" | grep -c '' || true)"
[ "${remaining}" = 0 ] || deny "${remaining} container(s) of ${PROJECT} survived compose down"
created=''
prove "teardown: the containers, volumes and networks of ${PROJECT} are gone"

printf 'proxy-e2e: SUMMARY image=%s proxy=%s steps=%d duration=%ds decision=pass\n' \
  "${image}" "${proxy}" "${proven}" "$(( $(date +%s) - started_at ))"
