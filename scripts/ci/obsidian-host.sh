#!/usr/bin/env bash
# obsidian-host -- the real Obsidian desktop on a macOS or Windows runner, the
# same two-instance journeys scripts/ci/obsidian-drive.mjs runs on Linux.
#
# WHY A SECOND HARNESS. There is no container runtime for Linux images on the
# macOS or Windows runners, so the server cannot come up the way
# scripts/ci/proxy-e2e.sh brings it up. The shape is the same -- the server on
# loopback, Caddy in front with deploy/proxies/caddy/Caddyfile and a throwaway
# authority, two Obsidian instances with their own `--user-data-dir` -- built
# from what each runner has:
#
#   macOS    the server built natively from this commit (the platform
#            requirement 14 names for development); the official Obsidian
#            dmg; the authority trusted in the System keychain, which is
#            where Chromium on macOS looks.
#   Windows  the server's static Linux build from this commit, run under
#            WSL 1 (the runner has it enabled; WSL 2 needs virtualisation the
#            runner does not offer) in a distribution imported from the Alpine
#            minirootfs; the official Obsidian installer, silent; the
#            authority in the machine Root store, which is where Chromium on
#            Windows looks; plus the NTFS journeys (a case-only rename, the
#            trash, a file another process holds open).
#
# THE TRUST IS MACHINE-WIDE on these two, unlike the Linux run: neither
# Chromium build reads a per-user store this run could scope to two
# processes. The runner is disposable and the authority is valid for one day;
# teardown removes it anyway.
#
# PINS: Obsidian 1.13.7 (GitHub's asset digests for obsidianmd/obsidian-
# releases), Caddy 2.10.2 (SHA-256 taken 2026-09-26 of the release archives,
# which also match the publisher's SHA-512 list), Alpine minirootfs 3.22.6
# (alpinelinux.org latest-releases.yaml).
#
# usage: obsidian-host.sh <obsyncd>   (macOS: a native build; Windows: the static linux/amd64 build)
# Requires: curl, openssl, node, tar/unzip; plugin/dist built.
set -euo pipefail

readonly OBSIDIAN_DMG='Obsidian-1.13.7.dmg 05daa54f1a4458f75da29f8faaa17e8e37ae16998432537f674c626db99bce'
readonly OBSIDIAN_EXE='Obsidian-1.13.7.exe f233dc24896b3f2d5f9e4b01111181a561d0760b2105f0a474024c5f3143a9bc'
readonly CADDY_MAC='caddy_2.10.2_mac_arm64.tar.gz cc9ad20742ea7bfee5dd1d435d42ab7fcf8592294f9ec43bf08fd21cbe448bc4'
readonly CADDY_WINDOWS='caddy_2.10.2_windows_amd64.zip 9fd1ef9be5d9b05852b66ccc25f96f23d8651bcab20779861a745bdffa273722'
readonly ALPINE='alpine-minirootfs-3.22.6-x86_64.tar.gz 27694aaa55fd7a9e3ef596e0ad4eb66802308bb20172b17030cd5f4d8ae9bac2'
readonly HOST='obsync-host.invalid'
readonly PORT=18643
readonly READY_BUDGET_SECONDS=120

if [ "$#" -ne 1 ]; then
  printf 'usage: %s <obsyncd>\n' "${0##*/}" >&2
  exit 2
fi
binary="$1"
here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "${here}/../.." && pwd)"
case "$(uname -s)" in
  Darwin) os=macos ;;
  MINGW* | MSYS*) os=windows ;;
  *) printf 'obsidian-host: DENY %s is neither macOS nor Windows\n' "$(uname -s)" >&2; exit 2 ;;
esac
run_id="$(printf '%s' "${OBSYNC_E2E_RUN_ID:-$$-${RANDOM}}" | tr -c '[:alnum:]_-' '-')"
# The Windows shell (MSYS) rewrites an argument that starts with `/` into a
# Windows path before a native program sees it, and a certificate subject is
# not a path: without this, openssl was handed `C:/Program Files/.../CN=...`.
export MSYS2_ARG_CONV_EXCL='/CN='
readonly DISTRO="obsync-e2e-${run_id}"
# The authority's name carries the run id, so teardown -- here and in the
# workflow's always() step -- removes this run's trust and nobody else's.
readonly CA_NAME="obsync e2e throwaway CA ${run_id}"

scratch="$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/obsidian-host.XXXXXX")"
scratch="$(cd "${scratch}" && pwd -P)"
server_pid=''
caddy_pid=''
trusted=''
distro=''

native() {
  # A path as the native programs on this runner read it.
  if [ "${os}" = windows ]; then cygpath -m "$1"; else printf '%s' "$1"; fi
}

wslpath_of() {
  # A Windows path as WSL mounts it: C:\x is /mnt/c/x.
  printf '/mnt%s' "$(cygpath -u "$1")"
}

wsl() {
  # Everything WSL is handed is a Linux path or command (`/bin/sh`,
  # `OBSYNC_BLOBS_DIR=/var/lib/...`), which the rewrite above would turn into
  # a path under the Git installation, so nothing it is given is rewritten.
  MSYS2_ARG_CONV_EXCL='*' wsl.exe "$@"
}

deny() {
  printf 'obsidian-host: DENY %s\n' "$1" >&2
  for log in openssl curl server caddy; do
    [ -f "${scratch}/${log}.log" ] && { printf 'obsidian-host: --- %s ---\n' "${log}" >&2; tail -n 30 "${scratch}/${log}.log" >&2; }
  done
  # Before the trap is armed nothing else removes the scratch directory.
  [ -n "${trusted}${distro}${server_pid}" ] || rm -rf -- "${scratch}"
  exit 1
}

cleanup() {
  local status=$?
  for pid in "${caddy_pid}" "${server_pid}"; do
    [ -n "${pid}" ] && kill "${pid}" >/dev/null 2>&1 || true
  done
  if [ -n "${distro}" ]; then
    wsl --terminate "${DISTRO}" >/dev/null 2>&1 || true
    wsl --unregister "${DISTRO}" >/dev/null 2>&1 || true
  fi
  if [ -n "${trusted}" ]; then
    if [ "${os}" = macos ]; then
      sudo security delete-certificate -c "${CA_NAME}" /Library/Keychains/System.keychain >/dev/null 2>&1 || true
    else
      certutil -delstore Root "${CA_NAME}" >/dev/null 2>&1 || true
    fi
  fi
  rm -rf -- "${scratch}"
  return "${status}"
}

fetch() {
  local url="$1" pin="$2" out="$3" name sha
  read -r name sha <<<"${pin}"
  curl --proto '=https' --tlsv1.2 -sSfL "${url}/${name}" -o "${out}" || deny "could not download ${name}"
  got="$( (sha256sum "${out}" 2>/dev/null || shasum -a 256 "${out}") | awk '{print $1}')"
  [ "${got}" = "${sha}" ] || deny "${name} does not match its pinned SHA-256 (${got:-nothing})"
}

ready() {
  # A process that has exited will not become ready: refuse at once, with its
  # log, instead of spending the whole budget on it.
  local pid="$1" name="$2"
  shift 2
  for _ in $(seq 1 "${READY_BUDGET_SECONDS}"); do
    curl --silent --show-error --max-time 2 "$@" 2>"${scratch}/curl.log" | grep -q '"ready":true' && return 0
    kill -0 "${pid}" 2>/dev/null || deny "${name} exited before it was ready"
    sleep 1
  done
  return 1
}

printf 'obsidian-host: START os=%s binary=%s host=%s port=%d\n' "${os}" "${binary}" "${HOST}" "${PORT}"
for tool in curl openssl node; do
  command -v "${tool}" >/dev/null 2>&1 || deny "${tool} is not installed; this script installs nothing"
done
[ -f "${binary}" ] || deny "no server binary at ${binary}"
for file in main.js manifest.json styles.css; do
  [ -f "${root}/plugin/dist/${file}" ] || deny "no built plugin (plugin/dist/${file})"
done
if [ "${os}" = windows ] && wsl --list --quiet 2>/dev/null | tr -d '\0\r' | grep -qx "${DISTRO}"; then
  deny "a WSL distribution called ${DISTRO} already exists"
fi

# Preflight has refused every reason not to start; from here a failure has
# something of this run's to remove.
trap cleanup EXIT

# (1) A throwaway authority and a leaf, RSA so every TLS stack here reads it.
openssl req -x509 -newkey rsa:2048 -nodes -days 1 -keyout "${scratch}/ca.key" -out "${scratch}/ca.crt" \
  -subj "/CN=${CA_NAME}" -addext 'basicConstraints=critical,CA:TRUE' -addext 'keyUsage=critical,keyCertSign' \
  >"${scratch}/openssl.log" 2>&1 || deny 'openssl could not make the authority'
openssl req -newkey rsa:2048 -nodes -keyout "${scratch}/tls.key" -out "${scratch}/leaf.csr" -subj "/CN=${HOST}" \
  >"${scratch}/openssl.log" 2>&1 || deny 'openssl could not make the leaf key'
printf 'subjectAltName=DNS:%s\nextendedKeyUsage=serverAuth\n' "${HOST}" > "${scratch}/leaf.ext"
openssl x509 -req -in "${scratch}/leaf.csr" -CA "${scratch}/ca.crt" -CAkey "${scratch}/ca.key" -CAcreateserial \
  -days 1 -extfile "${scratch}/leaf.ext" -out "${scratch}/tls.crt" >"${scratch}/openssl.log" 2>&1 \
  || deny 'openssl could not sign the leaf'
rm -f -- "${scratch}/openssl.log"
if [ "${os}" = macos ]; then
  sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain "${scratch}/ca.crt" \
    || deny 'the System keychain would not trust the authority'
else
  certutil -addstore -f Root "$(native "${scratch}/ca.crt")" >/dev/null || deny 'the Root store would not take the authority'
fi
trusted=yes
printf 'obsidian-host: (1) an authority trusted by this runner for one day\n'

# (2) The server on loopback.
if [ "${os}" = macos ]; then
  install -d -m 0700 "${scratch}/blobs" "${scratch}/journal"
  # Exactly this configuration and nothing inherited: the server refuses an
  # OBSYNC_ variable it does not know, and this job's OBSYNC_E2E_RUN_ID is one.
  env -i OBSYNC_LISTEN=127.0.0.1:8080 OBSYNC_BLOBS_DIR="${scratch}/blobs" OBSYNC_JOURNAL_DIR="${scratch}/journal" \
    OBSYNC_BLOBS_CAPACITY=8GiB OBSYNC_JOURNAL_CAPACITY=4GiB \
    OBSYNC_DASHBOARD_DIR="${root}/dashboard" OBSYNC_PLUGIN_DIR="${root}/plugin/dist" \
    OBSYNC_EDGE=none OBSYNC_TRUSTED_PROXY_CIDRS=127.0.0.1/32 OBSYNC_PUBLIC_URL="https://${HOST}:${PORT}" \
    "${binary}" serve >"${scratch}/server.log" 2>&1 &
  server_pid=$!
else
  fetch https://dl-cdn.alpinelinux.org/alpine/v3.22/releases/x86_64 "${ALPINE}" "${scratch}/rootfs.tar.gz"
  distro=yes
  wsl --import "${DISTRO}" "$(native "${scratch}/wsl")" "$(native "${scratch}/rootfs.tar.gz")" --version 1 \
    || deny 'WSL 1 would not import the Alpine distribution'
  wsl -d "${DISTRO}" -- /bin/sh -c "install -D -m 0755 '$(wslpath_of "${binary}")' /usr/local/bin/obsyncd \
    && install -d -m 0700 /var/lib/obsync/blobs /var/lib/obsync/journal \
    && mkdir -p /opt/obsync && cp -R '$(wslpath_of "${root}/dashboard")' /opt/obsync/dashboard \
    && cp -R '$(wslpath_of "${root}/plugin/dist")' /opt/obsync/plugin" || deny 'could not install the server in WSL'
  wsl -d "${DISTRO}" -- env OBSYNC_LISTEN=127.0.0.1:8080 OBSYNC_BLOBS_DIR=/var/lib/obsync/blobs \
    OBSYNC_JOURNAL_DIR=/var/lib/obsync/journal OBSYNC_BLOBS_CAPACITY=8GiB OBSYNC_JOURNAL_CAPACITY=4GiB \
    OBSYNC_EDGE=none OBSYNC_TRUSTED_PROXY_CIDRS=127.0.0.1/32 OBSYNC_PUBLIC_URL="https://${HOST}:${PORT}" \
    /usr/local/bin/obsyncd serve >"${scratch}/server.log" 2>&1 &
  server_pid=$!
fi
ready "${server_pid}" 'the server' 'http://127.0.0.1:8080/readyz' || deny "the server did not answer /readyz within ${READY_BUDGET_SECONDS}s"
printf 'obsidian-host: (2) the server serves /readyz on 127.0.0.1:8080 (%s)\n' "$([ "${os}" = macos ] && echo native || echo 'WSL 1')"

# (3) Caddy in front, from the committed configuration with its certificate
# paths, its port and its upstream moved to this run's.
if [ "${os}" = macos ]; then
  fetch https://github.com/caddyserver/caddy/releases/download/v2.10.2 "${CADDY_MAC}" "${scratch}/caddy.tar.gz"
  tar -xzf "${scratch}/caddy.tar.gz" -C "${scratch}" caddy
  caddy="${scratch}/caddy"
else
  fetch https://github.com/caddyserver/caddy/releases/download/v2.10.2 "${CADDY_WINDOWS}" "${scratch}/caddy.zip"
  unzip -q -o "${scratch}/caddy.zip" caddy.exe -d "${scratch}"
  caddy="${scratch}/caddy.exe"
fi
tls="$(native "${scratch}")"
sed -e "s# /tls/tls.crt # ${tls}/tls.crt #; s# /tls/tls.key\$# ${tls}/tls.key#; s#:8443 {#:${PORT} {#" \
  -e "s#reverse_proxy obsync:8080 {#reverse_proxy 127.0.0.1:8080 {#" \
  "${root}/deploy/proxies/caddy/Caddyfile" > "${scratch}/Caddyfile"
for moved in ":${PORT} {" "tls ${tls}/tls.crt ${tls}/tls.key" "reverse_proxy 127.0.0.1:8080 {"; do
  grep -qF "${moved}" "${scratch}/Caddyfile" \
    || deny "deploy/proxies/caddy/Caddyfile no longer has the line this run moves to: ${moved}"
done
OBSYNC_HOST="${HOST}" XDG_DATA_HOME="$(native "${scratch}/xdg-data")" \
  XDG_CONFIG_HOME="$(native "${scratch}/xdg-config")" \
  "${caddy}" run --config "$(native "${scratch}/Caddyfile")" --adapter caddyfile >"${scratch}/caddy.log" 2>&1 &
caddy_pid=$!
ready "${caddy_pid}" Caddy --cacert "${scratch}/ca.crt" --resolve "${HOST}:${PORT}:127.0.0.1" "https://${HOST}:${PORT}/readyz" \
  || deny "no {\"ready\":true through Caddy within ${READY_BUDGET_SECONDS}s"
printf 'obsidian-host: (3) Caddy serves /readyz over TLS from deploy/proxies/caddy/Caddyfile\n'

# (4) The token, into a 0600 file the driver deletes once read.
umask 077
if [ "${os}" = macos ]; then
  tr -d '[:space:]' < "${scratch}/journal/v1/setup-token" > "${scratch}/token"
else
  wsl -d "${DISTRO}" -- cat /var/lib/obsync/journal/v1/setup-token | tr -d '[:space:]' > "${scratch}/token"
fi
umask 022
if [ -n "${GITHUB_ACTIONS:-}" ]; then
  printf '::add-mask::%s\n' "$(cat "${scratch}/token")"
fi

# (5) Obsidian, by digest.
if [ "${os}" = macos ]; then
  fetch https://github.com/obsidianmd/obsidian-releases/releases/download/v1.13.7 "${OBSIDIAN_DMG}" "${scratch}/Obsidian.dmg"
  hdiutil attach -nobrowse -readonly -mountpoint "${scratch}/dmg" "${scratch}/Obsidian.dmg" >/dev/null || deny 'the dmg would not mount'
  cp -R "${scratch}/dmg/Obsidian.app" "${scratch}/Obsidian.app"
  hdiutil detach "${scratch}/dmg" >/dev/null || true
  obsidian="${scratch}/Obsidian.app/Contents/MacOS/Obsidian"
  ntfs=0
else
  fetch https://github.com/obsidianmd/obsidian-releases/releases/download/v1.13.7 "${OBSIDIAN_EXE}" "${scratch}/Obsidian-setup.exe"
  # `/S` is the installer's switch, not a path: unrewritten, as `taskkill //F`
  # in the workflow's cleanup is by doubling.
  MSYS2_ARG_CONV_EXCL='*' "${scratch}/Obsidian-setup.exe" /S || deny 'the Obsidian installer failed silently'
  obsidian=''
  for candidate in "${LOCALAPPDATA:-}/Programs/Obsidian/Obsidian.exe" "${LOCALAPPDATA:-}/Programs/obsidian/Obsidian.exe" \
    "${PROGRAMFILES:-}/Obsidian/Obsidian.exe"; do
    [ -f "$(cygpath -u "${candidate}")" ] && obsidian="$(cygpath -m "${candidate}")" && break
  done
  [ -n "${obsidian}" ] || deny 'the installer finished but no Obsidian.exe was found where it installs'
  ntfs=1
fi
[ -e "$(cygpath -u "${obsidian}" 2>/dev/null || printf '%s' "${obsidian}")" ] || deny "no Obsidian executable at ${obsidian}"
printf 'obsidian-host: (4) Obsidian 1.13.7 at %s\n' "${obsidian}"

# (6) The journeys.
mkdir -p "${scratch}/work"
OBSIDIAN_BIN="${obsidian}" OBSYNC_E2E_WORK="$(native "${scratch}/work")" OBSYNC_E2E_PLUGIN="$(native "${root}/plugin/dist")" \
  OBSYNC_E2E_URL="https://${HOST}:${PORT}" OBSYNC_E2E_TOKEN_FILE="$(native "${scratch}/token")" OBSYNC_E2E_NTFS="${ntfs}" \
  OBSYNC_E2E_ARGS="[\"--host-resolver-rules=MAP ${HOST} 127.0.0.1\"]" \
  node "$(native "${here}/obsidian-drive.mjs")" || deny 'the Obsidian instances did not complete the journeys'
printf 'obsidian-host: SUMMARY os=%s decision=pass\n' "${os}"
