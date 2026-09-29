#!/usr/bin/env bash
# binary-e2e -- the release tarball's contents installed as its own systemd
# unit says, behind the distribution's nginx, on a host with no container in
# the serving path.
#
# WHY. Every other run starts the server from its container image. A deployer
# who wants no container at all -- a NAS, a VM, a small board -- unpacks the
# static server tarball and runs it under systemd (docs/server.md, "Without a
# container: the static binary"). The review names it M2: the binary from this
# commit, systemd, distro nginx in front, the same device flow.
#
# THE INPUT IS THE TARBALL'S TREE: the Dockerfile's `server-dist` stage, which
# the release packs byte for byte -- `obsyncd`, `dashboard/`, `plugin/`,
# `obsyncd.service`, `LICENSE`. The unit is installed as shipped, with only its
# names moved to this run's (the user, /opt/obsync, /var/lib/obsync,
# /etc/obsync), so every hardening line it carries is the one that runs.
#
# WHAT IT PROVES:
#   1. preflight   root (it creates a user and two units), systemd as the
#                  init, nginx and its www-data user, the tree given, nothing
#                  of this run's name standing, 8080 and 8443 free.
#   2. installed   the unit's own header, step by step: a system user, the
#                  tree under a root-owned directory, a 0600 environment file
#                  holding the two capacities.
#   3. the service the shipped unit starts; systemd creates the two state
#                  directories 0700 for the user under a root-owned parent;
#                  `/readyz` answers on 127.0.0.1:8080 and nothing else
#                  listens on 8080.
#   4. nginx       the distribution's nginx binary, as www-data in a unit of
#                  its own, runs deploy/proxies/nginx/nginx.conf with only
#                  its host paths moved: the upstream to 127.0.0.1:8080, /tls
#                  to this run's leaf, /tmp to this run's directory. No
#                  directive is changed or dropped, so the file's own
#                  `listen ... http2` and `error_log stderr` are what start
#                  under systemd, where the error stream is a journal socket.
#                  The system's own nginx and /etc/nginx are never touched.
#                  `nginx -t` passes and `/readyz` answers over TLS.
#   5. it syncs    `api_flow.py enroll`, then `api_flow.py proxy`: the largest
#                  chunk, a full batch, a held and a woken long poll, and the
#                  address the server records is the one nginx saw
#                  (127.0.0.1), not a forged X-Forwarded-For.
#   6. a restart   `systemctl restart`, then `api_flow.py verify`.
#   7. teardown    both units stopped, the unit file, the tree, the state,
#                  the environment file and the user removed.
#
# usage: binary-e2e.sh <server-dist directory>
# Requires: systemd, nginx, sudo (or root), runuser, curl, openssl, python3, ss.
set -euo pipefail

if [ "$#" -ne 1 ]; then
  printf 'usage: %s <server-dist directory>\n' "${0##*/}" >&2
  exit 2
fi
dist="$1"

here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "${here}/../.." && pwd)"
run_id="$(printf '%s' "${OBSYNC_E2E_RUN_ID:-$$-${RANDOM}}" | tr -c '[:alnum:]_-' '-')"
readonly NAME="obsync-e2e-${run_id}"
# Every name the unit fixes is moved to one of this run's: a fixed name is one
# another run -- or a real installation on this host -- could own.
readonly SERVICE_USER="${NAME}"
readonly INSTALL="/opt/${NAME}"
readonly STATE="/var/lib/${NAME}"
readonly ENV_DIR="/etc/${NAME}"
readonly UNIT="/etc/systemd/system/${NAME}.service"
readonly FRONT="/srv/${NAME}-nginx"
readonly TLS="${FRONT}/tls"
readonly NGINX_USER='www-data'
readonly HTTPS_PORT=8443
readonly HOST='obsync-binary.invalid'
readonly READY_BUDGET_SECONDS=60

sudo_() {
  if [ "$(id -u)" -eq 0 ]; then "$@"; else sudo "$@"; fi
}

scratch="$(mktemp -d "${TMPDIR:-/tmp}/binary-e2e.XXXXXX")"
created=''
started_at="$(date +%s)"
step_at="${started_at}"

proven=0
prove() {
  local now
  now="$(date +%s)"
  proven=$((proven + 1))
  printf 'binary-e2e: (%d) %s [%ds]\n' "${proven}" "$1" "$((now - step_at))"
  step_at="${now}"
}

deny() {
  printf 'binary-e2e: DENY %s\n' "$1" >&2
  if [ -n "${created}" ]; then
    sudo_ journalctl --unit "${NAME}" --no-pager --lines 40 >&2 2>&1 || true
    sudo_ journalctl --unit "${NAME}-nginx" --no-pager --lines 20 >&2 2>&1 || true
  fi
  exit 1
}

cleanup() {
  local status=$?
  if [ -n "${created}" ]; then
    sudo_ systemctl stop "${NAME}" "${NAME}-nginx" >/dev/null 2>&1 || true
    sudo_ systemctl reset-failed "${NAME}" "${NAME}-nginx" >/dev/null 2>&1 || true
    sudo_ rm -f "${UNIT}"
    sudo_ systemctl daemon-reload >/dev/null 2>&1 || true
    sudo_ rm -rf -- "${INSTALL}" "${STATE}" "${ENV_DIR}" "${FRONT}"
    sudo_ userdel "${SERVICE_USER}" >/dev/null 2>&1 || true
  fi
  rm -rf -- "${scratch}"
  return "${status}"
}

ready_direct() {
  curl --silent --max-time 2 'http://127.0.0.1:8080/readyz' 2>/dev/null | grep -q '"ready":true'
}
ready_tls() {
  curl --silent --max-time 2 --cacert "${scratch}/ca.crt" --resolve "${HOST}:${HTTPS_PORT}:127.0.0.1" \
    "https://${HOST}:${HTTPS_PORT}/readyz" 2>/dev/null | grep -q '"ready":true'
}
start_nginx() {
  # The distribution's nginx binary with the adapted file, as its own
  # unprivileged unit: 8443 needs no capability, so it is given none.
  sudo_ systemd-run --unit "${NAME}-nginx" --description 'obsync end-to-end (distro nginx)' \
    --uid "${NGINX_USER}" --gid "${NGINX_USER}" \
    --property NoNewPrivileges=yes --property CapabilityBoundingSet= \
    "${nginx_binary}" -e stderr -c "${FRONT}/nginx.conf" -g 'daemon off;' >/dev/null
}
wait_for() {
  for _ in $(seq 1 "${READY_BUDGET_SECONDS}"); do
    "$1" && return 0
    sleep 1
  done
  deny "$2 within ${READY_BUDGET_SECONDS}s"
}

printf 'binary-e2e: START dist=%s unit=%s host=%s\n' "${dist}" "${NAME}" "${HOST}"

# (1) Preflight.
[ "$(cat /proc/1/comm)" = systemd ] || deny 'systemd is not this host'"'"'s init'
for tool in nginx systemctl systemd-run runuser curl openssl python3 ss; do
  command -v "${tool}" >/dev/null 2>&1 || sudo_ sh -c "command -v ${tool}" >/dev/null 2>&1 \
    || deny "${tool} is not installed; this script installs nothing"
done
[ -x "${dist}/obsyncd" ] || deny "no executable obsyncd in ${dist}"
[ -f "${dist}/dashboard/index.html" ] || deny "no dashboard in ${dist}"
[ -f "${dist}/plugin/main.js" ] || deny "no plugin bundle in ${dist}"
[ -f "${dist}/obsyncd.service" ] || deny "no obsyncd.service in ${dist}"
[ -f "${root}/deploy/proxies/nginx/nginx.conf" ] || deny 'no deploy/proxies/nginx/nginx.conf'
! id "${SERVICE_USER}" >/dev/null 2>&1 || deny "a user called ${SERVICE_USER} already exists"
for path in "${INSTALL}" "${STATE}" "${ENV_DIR}" "${UNIT}" "${FRONT}"; do
  [ ! -e "${path}" ] || deny "${path} already exists"
done
id "${NGINX_USER}" >/dev/null 2>&1 || deny "no ${NGINX_USER} user, which the distribution's nginx package creates"
nginx_binary="$(command -v nginx || sudo_ sh -c 'command -v nginx')"
for port in 8080 "${HTTPS_PORT}"; do
  if ss -ltnH | awk '{print $4}' | grep -q ":${port}$"; then deny "something already listens on port ${port}"; fi
done
nginx_version="$("${nginx_binary}" -v 2>&1 | sed -n 's|^nginx version: nginx/\([0-9.]*\).*|\1|p')"
[ -n "${nginx_version}" ] || deny "${nginx_binary} -v names no version"
prove "preflight: systemd, nginx ${nginx_version}, $("${dist}/obsyncd" version 2>/dev/null || echo obsyncd), nothing on 8080 or ${HTTPS_PORT}"

trap cleanup EXIT

# (2) Installed as the unit's header says, under this run's names.
created='install'
sudo_ useradd --system --no-create-home --shell /usr/sbin/nologin "${SERVICE_USER}"
sudo_ install -d -m 0755 -o root -g root "${INSTALL}"
sudo_ cp -R "${dist}/." "${INSTALL}/"
sudo_ chown -R root:root "${INSTALL}"
sudo_ chmod -R go-w,a+rX "${INSTALL}"
sudo_ install -d -m 0755 -o root -g root "${ENV_DIR}"
sudo_ install -m 0600 -o root -g root /dev/null "${ENV_DIR}/obsyncd.env"
printf 'OBSYNC_BLOBS_CAPACITY=8GiB\nOBSYNC_JOURNAL_CAPACITY=4GiB\nOBSYNC_PUBLIC_URL=https://%s:%s\n' "${HOST}" "${HTTPS_PORT}" \
  | sudo_ tee "${ENV_DIR}/obsyncd.env" >/dev/null
prove "installed: ${SERVICE_USER}, the tree in ${INSTALL} owned by root, ${ENV_DIR}/obsyncd.env 0600 with the two capacities"

# (3) The shipped unit, with only its names moved.
unit="$(sed -e "s|^User=obsync$|User=${SERVICE_USER}|" -e "s|^Group=obsync$|Group=${SERVICE_USER}|" \
  -e "s|/opt/obsync/|${INSTALL}/|g" -e "s|/var/lib/obsync/|${STATE}/|g" \
  -e "s|^EnvironmentFile=/etc/obsync/obsyncd.env$|EnvironmentFile=${ENV_DIR}/obsyncd.env|" \
  -e "s|^StateDirectory=obsync/blobs obsync/journal$|StateDirectory=${NAME}/blobs ${NAME}/journal|" \
  "${dist}/obsyncd.service")"
for moved in "User=${SERVICE_USER}" "ExecStart=${INSTALL}/obsyncd serve" "Environment=OBSYNC_JOURNAL_DIR=${STATE}/journal" \
  "EnvironmentFile=${ENV_DIR}/obsyncd.env" "StateDirectory=${NAME}/blobs ${NAME}/journal"; do
  grep -qxF "${moved}" <<<"${unit}" || deny "obsyncd.service no longer carries the line this run moves to: ${moved}"
done
# A setting that still names a shipped path or the shipped user would reach
# outside this run -- a line added to the unit later that this run never moved.
if grep -v '^#' <<<"${unit}" | sed "s|${NAME}||g" \
  | grep -Eq '(/opt/|/var/lib/|/etc/)obsync([^d]|$)|^(User|Group)=obsync$|(^|[= ])obsync/'; then
  deny 'obsyncd.service names a path or user this run did not move'
fi
printf '%s\n' "${unit}" | sudo_ tee "${UNIT}" >/dev/null
sudo_ chmod 0644 "${UNIT}"
sudo_ systemctl daemon-reload || deny 'systemd would not load the unit'
sudo_ systemctl start "${NAME}" || deny 'the shipped unit would not start'
wait_for ready_direct 'no {"ready":true on 127.0.0.1:8080'
listeners="$(ss -ltnH | awk '{print $4}' | grep ':8080$' | sort -u | tr '\n' ' ')"
[ "${listeners}" = '127.0.0.1:8080 ' ] || deny "port 8080 is bound at ${listeners:-nothing}, not only at 127.0.0.1:8080"
for directory in blobs journal; do
  owner="$(sudo_ stat -c '%U %a' "${STATE}/${directory}")"
  [ "${owner}" = "${SERVICE_USER} 700" ] || deny "${STATE}/${directory} is ${owner}, not ${SERVICE_USER} 700"
done
parent="$(sudo_ stat -c '%U %a' "${STATE}")"
[ "${parent}" = 'root 755' ] || deny "${STATE} is ${parent}, not root 755"
prove "the service: the shipped unit runs ${INSTALL}/obsyncd as ${SERVICE_USER}, systemd made both state directories 0700 under a root-owned ${STATE}, /readyz answers on ${listeners% } only"

# (4) The committed nginx configuration, with only its host paths moved.
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -days 1 \
  -keyout "${scratch}/ca.key" -out "${scratch}/ca.crt" -subj '/CN=obsync e2e throwaway CA' \
  -addext 'basicConstraints=critical,CA:TRUE' -addext 'keyUsage=critical,keyCertSign' >/dev/null 2>&1 \
  || deny 'openssl could not make the authority'
openssl req -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -keyout "${scratch}/tls.key" \
  -out "${scratch}/leaf.csr" -subj "/CN=${HOST}" >/dev/null 2>&1 || deny 'openssl could not make the leaf key'
printf 'subjectAltName=DNS:%s\nextendedKeyUsage=serverAuth\n' "${HOST}" > "${scratch}/leaf.ext"
openssl x509 -req -in "${scratch}/leaf.csr" -CA "${scratch}/ca.crt" -CAkey "${scratch}/ca.key" -CAcreateserial \
  -days 1 -extfile "${scratch}/leaf.ext" -out "${scratch}/tls.crt" >/dev/null 2>&1 || deny 'openssl could not sign the leaf'
# A root-owned directory holds the file and the leaf; the one directory
# nginx writes (its pid and temporary files) is www-data's, 0700.
sudo_ install -d -m 0755 -o root -g root "${FRONT}" "${TLS}"
sudo_ install -d -m 0700 -o "${NGINX_USER}" -g "${NGINX_USER}" "${FRONT}/run"
sudo_ install -m 0644 -o root -g root "${scratch}/tls.crt" "${TLS}/tls.crt"
sudo_ install -m 0640 -o root -g "${NGINX_USER}" "${scratch}/tls.key" "${TLS}/tls.key"
config="$(sed -e 's|proxy_pass http://obsync:8080;|proxy_pass http://127.0.0.1:8080;|' \
  -e "s|/tls/|${TLS}/|g" -e "s|/tmp/|${FRONT}/run/|g" "${root}/deploy/proxies/nginx/nginx.conf")"
for moved in 'proxy_pass http://127.0.0.1:8080;' "ssl_certificate_key ${TLS}/tls.key;" "pid ${FRONT}/run/nginx.pid;"; do
  grep -q "${moved}" <<<"${config}" \
    || deny "deploy/proxies/nginx/nginx.conf no longer carries the line this run moves to: ${moved}"
done
printf '%s\n' "${config}" | sudo_ tee "${FRONT}/nginx.conf" >/dev/null
sudo_ chmod 0644 "${FRONT}/nginx.conf"
# The check runs as the user the unit runs as, so nothing it creates is root's.
sudo_ runuser -u "${NGINX_USER}" -- "${nginx_binary}" -e stderr -c "${FRONT}/nginx.conf" -t \
  >"${scratch}/nginx-t.log" 2>&1 \
  || deny "nginx -t refused the committed configuration: $(tr '\n' ' ' < "${scratch}/nginx-t.log")"
start_nginx || deny 'systemd-run refused the nginx unit'
wait_for ready_tls 'no {"ready":true through nginx over TLS'
prove "nginx: deploy/proxies/nginx/nginx.conf on nginx ${nginx_version}, every directive as shipped, passes nginx -t as ${NGINX_USER} and serves /readyz on ${HTTPS_PORT} over TLS to 127.0.0.1:8080"

# (5) The flow, and the address the server records.
umask 077
sudo_ cat "${STATE}/journal/v1/setup-token" | tr -d '[:space:]' > "${scratch}/token" || deny 'no setup token'
umask 022
if [ -n "${GITHUB_ACTIONS:-}" ]; then
  printf '::add-mask::%s\n' "$(cat "${scratch}/token")"
fi
python3 -B "${here}/api_flow.py" enroll --host "${HOST}" --port "${HTTPS_PORT}" --address 127.0.0.1 \
  --cacert "${scratch}/ca.crt" --state "${scratch}/devices.json" < "${scratch}/token" \
  || deny 'the sync flow failed through distro nginx'
# The proxy properties through the distribution's nginx. The bypass is not
# asked: on one host the client can always reach the loopback listener, and
# step 3 already proved that loopback is the only place the server listens.
python3 -B "${here}/api_flow.py" proxy --host "${HOST}" --port "${HTTPS_PORT}" --address 127.0.0.1 \
  --cacert "${scratch}/ca.crt" --state "${scratch}/devices.json" --expect-address 127.0.0.1 --bypass none \
  || deny 'distro nginx broke a property the sync path needs'
prove 'it syncs: first boot, pairing, the largest chunk, a full batch, held and woken long polls, and the address nginx saw, through distro nginx'

# (6) A restart keeps everything.
sudo_ systemctl restart "${NAME}" || deny 'the service would not restart'
wait_for ready_tls 'no {"ready":true after the restart'
python3 -B "${here}/api_flow.py" verify --host "${HOST}" --port "${HTTPS_PORT}" --address 127.0.0.1 \
  --cacert "${scratch}/ca.crt" --state "${scratch}/devices.json" \
  || deny 'the restarted service lost the account, the devices or the data'
prove 'a restart: both devices, the file and the spent nonce came back'

# (7) Teardown, proven.
sudo_ systemctl stop "${NAME}" "${NAME}-nginx" >/dev/null 2>&1 || true
sudo_ rm -f "${UNIT}"
sudo_ systemctl daemon-reload || deny 'systemd would not reload without the unit'
sudo_ rm -rf -- "${INSTALL}" "${STATE}" "${ENV_DIR}" "${FRONT}"
sudo_ userdel "${SERVICE_USER}" || deny "could not remove ${SERVICE_USER}"
created=''
prove "teardown: ${NAME}, ${NAME}-nginx, the unit file, the tree, the state and ${SERVICE_USER} are gone"
printf 'binary-e2e: SUMMARY unit=%s steps=%d duration=%ds decision=pass\n' \
  "${NAME}" "${proven}" "$(( $(date +%s) - started_at ))"
