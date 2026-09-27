#!/usr/bin/env bash
# obsidian-e2e -- the real Obsidian desktop for Linux, two instances, driven by
# scripts/ci/obsidian-drive.mjs against a server this run did not start.
#
# It is the `--then` command of `scripts/ci/proxy-e2e.sh <image> caddy`, which
# stands the server up behind Caddy and hands over, in the environment, the
# name and port to reach, the authority to trust and a 0600 file holding the
# UNSPENT setup token. This file adds what only a Linux desktop needs:
#
#   - Obsidian itself: the official AppImage for this machine's architecture,
#     refused unless its SHA-256 matches the pin below, unpacked (no FUSE).
#   - A display: Xvfb, private to this run.
#   - Trust for exactly two processes. Chromium on Linux reads locally added
#     authorities from the NSS database under $HOME/.pki/nssdb, not from the
#     system store `update-ca-certificates` writes. Each instance runs with a
#     HOME of its own holding an NSS database that trusts the throwaway
#     authority, and nothing else on the host trusts it.
#   - The name: Chromium's `--host-resolver-rules` maps it to the address the
#     proxy is published on, so no hosts file is edited.
#
# THE SANDBOX. The instances run with `--no-sandbox`: an unpacked AppImage has
# no setuid sandbox helper and Ubuntu 24.04 restricts the unprivileged user
# namespaces Chromium would use instead. This is a disposable CI desktop
# driving a vault of generated notes; it is stated here, not hidden.
#
# PINS, from the Obsidian release record (GitHub's asset digests for
# obsidianmd/obsidian-releases v1.13.7, the newest release carrying Linux
# assets on 2026-09-26; v1.13.8 shipped Android only). The plugin's own floor
# is 1.13.0 (manifest.json).
#
# Requires: curl, Xvfb, certutil (libnss3-tools), node (Node 22 or later for
# its built-in WebSocket), and the built plugin in plugin/dist.
set -euo pipefail

readonly OBSIDIAN_VERSION=1.13.7
readonly APPIMAGE_AMD64="Obsidian-${OBSIDIAN_VERSION}.AppImage e0d8e0a611624de8c9c7dcd8a9e648279fb0a0d552faa1312b7e4f3a5fa72663"
readonly APPIMAGE_ARM64="Obsidian-${OBSIDIAN_VERSION}-arm64.AppImage e286fd2bb2a5d346a35a577bd764c73fd5537dddec2b99a1a3e5e35974085203"

here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "${here}/../.." && pwd)"
: "${OBSYNC_E2E_HOST:?run this through scripts/ci/proxy-e2e.sh --then}"
: "${OBSYNC_E2E_PORT:?}" "${OBSYNC_E2E_CACERT:?}" "${OBSYNC_E2E_TOKEN_FILE:?}"
# Where the proxy is reached from here: its published loopback port on a
# runner, or its address on the client network when this runs in a container.
address="${OBSYNC_E2E_ADDRESS:-127.0.0.1}"
plugin="${OBSYNC_E2E_PLUGIN:-${root}/plugin/dist}"

scratch="$(mktemp -d "${TMPDIR:-/tmp}/obsidian-e2e.XXXXXX")"
xvfb_pid=''
cleanup() {
  local status=$?
  if [ -n "${xvfb_pid}" ]; then
    kill "${xvfb_pid}" >/dev/null 2>&1 || true
  fi
  rm -rf -- "${scratch}"
  return "${status}"
}
trap cleanup EXIT

deny() {
  printf 'obsidian-e2e: DENY %s\n' "$1" >&2
  exit 1
}

for tool in curl Xvfb certutil node sha256sum; do
  command -v "${tool}" >/dev/null 2>&1 || deny "${tool} is not installed; this script installs nothing"
done
for file in main.js manifest.json styles.css; do
  [ -f "${plugin}/${file}" ] || deny "no built plugin at ${plugin} (${file} missing): run npm run build in plugin/"
done
case "$(uname -m)" in
  x86_64 | amd64) read -r asset sha <<<"${APPIMAGE_AMD64}" ;;
  aarch64 | arm64) read -r asset sha <<<"${APPIMAGE_ARM64}" ;;
  *) deny "no Obsidian AppImage for $(uname -m)" ;;
esac
printf 'obsidian-e2e: START obsidian=%s asset=%s url=https://%s:%s address=%s\n' \
  "${OBSIDIAN_VERSION}" "${asset}" "${OBSYNC_E2E_HOST}" "${OBSYNC_E2E_PORT}" "${address}"

# Obsidian, by digest, unpacked. `OBSYNC_E2E_APPIMAGE` names a copy already on
# disk; it is held to the same pin.
if [ -n "${OBSYNC_E2E_APPIMAGE:-}" ]; then
  cp "${OBSYNC_E2E_APPIMAGE}" "${scratch}/Obsidian.AppImage" || deny "no AppImage at ${OBSYNC_E2E_APPIMAGE}"
else
  curl --proto '=https' --tlsv1.2 -sSfL \
    "https://github.com/obsidianmd/obsidian-releases/releases/download/v${OBSIDIAN_VERSION}/${asset}" \
    -o "${scratch}/Obsidian.AppImage" || deny "could not download ${asset}"
fi
printf '%s  %s\n' "${sha}" "${scratch}/Obsidian.AppImage" | sha256sum -c - >/dev/null \
  || deny "${asset} does not match its pinned SHA-256"
chmod +x "${scratch}/Obsidian.AppImage"
# The AppImage's own unpacker links `libz.so`, the name only zlib's DEVELOPMENT
# package provides; a private symlink to the runtime library stands in for it,
# so nothing is installed for one unpack.
mkdir -p "${scratch}/lib"
libz="$(ldconfig -p | awk '/libz\.so\.1 /{print $NF; exit}')"
[ -n "${libz}" ] || deny 'no libz.so.1 on this host'
ln -s "${libz}" "${scratch}/lib/libz.so"
(cd "${scratch}" && LD_LIBRARY_PATH="${scratch}/lib" ./Obsidian.AppImage --appimage-extract >/dev/null) \
  || deny 'the AppImage would not unpack'
binary="${scratch}/squashfs-root/obsidian"
[ -x "${binary}" ] || deny "the unpacked AppImage has no ${binary##*/}"
printf 'obsidian-e2e: Obsidian %s unpacked, sha256 %s\n' "${OBSIDIAN_VERSION}" "${sha}"

# A display of our own.
for display in $(seq 90 99); do
  [ -e "/tmp/.X11-unix/X${display}" ] || break
done
Xvfb ":${display}" -screen 0 1280x800x24 -nolisten tcp >"${scratch}/xvfb.log" 2>&1 &
xvfb_pid=$!
export DISPLAY=":${display}"
for _ in $(seq 1 20); do
  [ -e "/tmp/.X11-unix/X${display}" ] && break
  sleep 0.5
done
[ -e "/tmp/.X11-unix/X${display}" ] || deny 'Xvfb did not start'

# Trust for the two instances only: an NSS database in each one's own HOME.
work="${scratch}/work"
for name in a b; do
  nssdb="${work}/${name}/home/.pki/nssdb"
  mkdir -p "${nssdb}"
  certutil -d "sql:${nssdb}" -N --empty-password
  certutil -d "sql:${nssdb}" -A -t 'C,,' -n 'obsync e2e throwaway CA' -i "${OBSYNC_E2E_CACERT}"
done

OBSIDIAN_BIN="${binary}" OBSYNC_E2E_WORK="${work}" OBSYNC_E2E_PLUGIN="${plugin}" \
  OBSYNC_E2E_URL="https://${OBSYNC_E2E_HOST}:${OBSYNC_E2E_PORT}" \
  OBSYNC_E2E_HOMES=1 \
  OBSYNC_E2E_ARGS="[\"--no-sandbox\",\"--disable-gpu\",\"--host-resolver-rules=MAP ${OBSYNC_E2E_HOST} ${address}\"]" \
  node "${here}/obsidian-drive.mjs" || deny 'the Obsidian instances did not complete the journeys'
printf 'obsidian-e2e: SUMMARY obsidian=%s decision=pass\n' "${OBSIDIAN_VERSION}"
