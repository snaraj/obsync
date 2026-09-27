#!/usr/bin/env bash
# proxy_matrix -- the same image behind Caddy, nginx, Traefik and HAProxy, from
# deploy/proxies/compose.yml, each on loopback with a throwaway private CA.
#
# For each proxy: the device flow of scripts/ci/api_flow.py through it (a file
# over the 1 MiB stock body ceiling included), then scripts/validation/
# forwarded_probe.py twice -- a client-forged X-Forwarded-For and Forwarded
# through the proxy must not be believed, and the same forgery sent straight
# to the server from another container on its network must not be either.
# Then one edge-mode leg with no proxy: the edge's headers are refused from a
# peer outside OBSYNC_TRUSTED_PROXY_CIDRS and admitted from inside it.
#
#   scripts/validation/proxy_matrix.sh <obsync image> [proxy ...]
#
# Needs docker (with compose), openssl, curl and python3; builds nothing.
# Requirement 12: one line per proven step, one SUMMARY with the decision.
set -euo pipefail

root="$(cd "$(dirname "$0")/../.." && pwd)"
image="${1:?usage: proxy_matrix.sh <obsync image> [proxy ...]}"
shift
proxies=("$@")
[ "${#proxies[@]}" -gt 0 ] || proxies=(caddy nginx traefik haproxy)

readonly HOST='sync.proxy.invalid'
readonly PORT=18843
readonly PROXY_ADDRESS='172.31.254.14'
readonly PROBE_IMAGE='docker.io/library/python:3.12-slim@sha256:f77ac9e44ae96ef2c90b8053ea08c31f8be030f824196b0ae4db6d462c84e51f'
readonly READY_BUDGET_SECONDS=60
started_at="$(date +%s)"
proven=0
scratch="$(mktemp -d)"
project=''

prove() { proven=$((proven + 1)); printf 'proxy-matrix: (%d) %s\n' "${proven}" "$1"; }
teardown() {
  if [ -n "${project}" ]; then
    docker compose --project-name "${project}" --file "${root}/deploy/proxies/compose.yml" \
      --profile "${proxy}" down --volumes --remove-orphans >/dev/null 2>&1 || true
    project=''
  fi
}
cleanup() {
  local status=$?
  teardown
  docker rm -f --volumes obsync-edge-probe-server >/dev/null 2>&1 || true
  docker network rm obsync-edge-probe >/dev/null 2>&1 || true
  rm -rf -- "${scratch}"
  return "${status}"
}
trap cleanup EXIT
deny() {
  printf 'proxy-matrix: DENY %s\n' "$1" >&2
  if [ -n "${project}" ]; then
    docker compose --project-name "${project}" --file "${root}/deploy/proxies/compose.yml" \
      --profile "${proxy}" logs --tail 30 >&2 2>&1 || true
  fi
  printf 'proxy-matrix: SUMMARY steps=%d duration=%ds decision=deny\n' "${proven}" "$(( $(date +%s) - started_at ))" >&2
  exit 1
}

# A throwaway authority that can sign for `.invalid` names and nothing else,
# and one leaf. The key is world-readable because it is this run's and every
# proxy reads it as its own unprivileged user.
tls="${scratch}/tls"
mkdir -p "${tls}"
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -days 1 \
  -keyout "${scratch}/ca.key" -out "${scratch}/ca.crt" -subj '/CN=obsync proxy matrix CA' \
  -addext 'basicConstraints=critical,CA:TRUE' -addext 'keyUsage=critical,keyCertSign' \
  -addext 'nameConstraints=critical,permitted;DNS:.invalid' >/dev/null 2>&1 || deny 'openssl could not make the CA'
openssl req -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes \
  -keyout "${tls}/tls.key" -out "${scratch}/leaf.csr" -subj "/CN=${HOST}" >/dev/null 2>&1 \
  || deny 'openssl could not make the leaf request'
printf 'subjectAltName=DNS:%s\nextendedKeyUsage=serverAuth\n' "${HOST}" > "${scratch}/leaf.ext"
openssl x509 -req -in "${scratch}/leaf.csr" -CA "${scratch}/ca.crt" -CAkey "${scratch}/ca.key" \
  -CAcreateserial -days 1 -extfile "${scratch}/leaf.ext" -out "${tls}/tls.crt" >/dev/null 2>&1 \
  || deny 'openssl could not sign the leaf'
chmod 0755 "${tls}"
chmod 0644 "${tls}/tls.crt" "${tls}/tls.key"

export OBSYNC_IMAGE="${image}" OBSYNC_HOST="${HOST}" OBSYNC_TLS_DIR="${tls}"
export OBSYNC_BIND_ADDRESS=127.0.0.1 OBSYNC_HTTPS_PORT="${PORT}"
export OBSYNC_BLOBS_CAPACITY=8GiB OBSYNC_JOURNAL_CAPACITY=4GiB
printf 'proxy-matrix: START image=%s proxies=%s ready_budget=%ds\n' "${image}" "${proxies[*]}" "${READY_BUDGET_SECONDS}"

for proxy in "${proxies[@]}"; do
  project="obsync-proxy-${proxy}-$$"
  compose=(docker compose --project-name "${project}" --file "${root}/deploy/proxies/compose.yml" --profile "${proxy}")
  "${compose[@]}" up --detach >"${scratch}/up.log" 2>&1 || deny "${proxy}: compose up failed: $(tr '\n' ' ' < "${scratch}/up.log")"
  ready=''
  for _ in $(seq 1 "${READY_BUDGET_SECONDS}"); do
    ready="$(curl --silent --max-time 3 --cacert "${scratch}/ca.crt" \
      --resolve "${HOST}:${PORT}:127.0.0.1" "https://${HOST}:${PORT}/readyz" || true)"
    case "${ready}" in '{"ready":true'*) break ;; esac
    sleep 1
  done
  case "${ready}" in '{"ready":true'*) ;; *) deny "${proxy}: no {\"ready\":true through the proxy within ${READY_BUDGET_SECONDS}s" ;; esac
  prove "${proxy}: /readyz answers through the proxy over TLS"

  state="${scratch}/${proxy}-devices.json"
  "${compose[@]}" exec -T obsync obsyncd setup-token 2>/dev/null | tr -d '[:space:]' \
    | python3 -B "${root}/scripts/ci/api_flow.py" enroll --host "${HOST}" --port "${PORT}" \
        --address 127.0.0.1 --cacert "${scratch}/ca.crt" --state "${state}" >"${scratch}/flow.log" 2>&1 \
    || deny "${proxy}: the device flow failed: $(tail -5 "${scratch}/flow.log" | tr '\n' ' ')"
  python3 -B "${root}/scripts/ci/api_flow.py" verify --host "${HOST}" --port "${PORT}" \
    --address 127.0.0.1 --cacert "${scratch}/ca.crt" --state "${state}" >>"${scratch}/flow.log" 2>&1 \
    || deny "${proxy}: the verify phase failed: $(tail -5 "${scratch}/flow.log" | tr '\n' ' ')"
  prove "${proxy}: enrol, pair, a 2 MiB push and pull, the four refusals, and verify all ran through it"

  # What the proxy saw this host's connection come from: the network's
  # gateway, where the published port lands.
  network="$(docker inspect --format '{{range $k, $v := .NetworkSettings.Networks}}{{$k}}{{end}}' "$("${compose[@]}" ps -q obsync)")"
  gateway="$(docker network inspect --format '{{range .IPAM.Config}}{{.Gateway}}{{end}}' "${network}")"
  python3 -B "${root}/scripts/validation/forwarded_probe.py" through --host "${HOST}" --port "${PORT}" \
    --address 127.0.0.1 --cacert "${scratch}/ca.crt" --state "${state}" --proxy "${PROXY_ADDRESS}" \
    --client "${gateway}" \
    || deny "${proxy}: a client-forged forwarded header through the proxy was believed, or the proxy's was not"
  prove "${proxy}: through the proxy, its own header is believed and a client's forgery is not"

  chmod 0644 "${state}"
  docker run --rm --network "${network}" --read-only --cap-drop ALL \
    -v "${root}/scripts/validation/forwarded_probe.py:/probe.py:ro" -v "${state}:/state.json:ro" \
    "${PROBE_IMAGE}" python3 -B /probe.py direct --host obsync --port 8080 --state /state.json \
    || deny "${proxy}: a forged forwarded header sent around the proxy was believed"
  prove "${proxy}: around the proxy, from an untrusted peer, the forgery is ignored"

  if [ -z "${SKIP_LONGPOLL:-}" ]; then
    python3 -B "${root}/scripts/validation/forwarded_probe.py" longpoll --host "${HOST}" --port "${PORT}" \
      --address 127.0.0.1 --cacert "${scratch}/ca.crt" --state "${state}" \
      || deny "${proxy}: the proxy cut the change feed's 55 s long poll"
    prove "${proxy}: the change feed's 55 s long poll comes back through the proxy"
  fi

  teardown
done

# The edge leg: the server alone in edge mode, trusting one address.
docker network create --subnet 172.31.253.0/28 obsync-edge-probe >/dev/null
docker run -d --name obsync-edge-probe-server --network obsync-edge-probe --read-only --cap-drop ALL \
  -e OBSYNC_EDGE=cloudflare -e OBSYNC_TRUSTED_PROXY_CIDRS=172.31.253.14/32 \
  -e OBSYNC_BLOBS_CAPACITY=1GiB -e OBSYNC_JOURNAL_CAPACITY=4GiB -e OBSYNC_FREE_WATERMARK=1%,1MiB \
  -v /data/blobs -v /data/journal "${image}" >/dev/null
for _ in $(seq 1 "${READY_BUDGET_SECONDS}"); do
  docker run --rm --network obsync-edge-probe "${PROBE_IMAGE}" python3 -c \
    'import urllib.request;urllib.request.urlopen("http://obsync-edge-probe-server:8080/readyz",timeout=2)' \
    >/dev/null 2>&1 && break
  sleep 1
done
for leg in '172.31.253.14 admitted' '172.31.253.9 refused'; do
  set -- ${leg}
  docker run --rm --network obsync-edge-probe --ip "$1" --read-only --cap-drop ALL \
    -v "${root}/scripts/validation/forwarded_probe.py:/probe.py:ro" \
    "${PROBE_IMAGE}" python3 -B /probe.py edge --host obsync-edge-probe-server --port 8080 --expect "$2" \
    || deny "edge mode: the edge's headers from $1 were not $2"
  prove "edge mode: the edge's headers from $1 are $2"
done

printf 'proxy-matrix: SUMMARY proxies=%s steps=%d duration=%ds decision=pass\n' \
  "${proxies[*]}" "${proven}" "$(( $(date +%s) - started_at ))"
