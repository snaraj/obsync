#!/usr/bin/env bash
# bench -- the numbers docs/benchmarks.md names, measured against the Compose
# deployment docs/server.md ships, with the image this commit builds.
#
# WHY THIS EXISTS. docs/benchmarks.md set targets (B1-B8) that nothing had
# ever measured, and described a `bench/` harness and an `obsyncd bench` verb
# that did not exist. A speed claim nobody can reproduce is a guess, and a
# regression nothing measures ships. This is the harness: `api_flow.py bench`
# drives the deployment as two signed devices would, and reads the server's
# own counters while it does.
#
# HOW THE SERVER IS READ. The bench client runs in a container that shares the
# server container's PID namespace (`--pid container:…`) and holds
# CAP_SYS_PTRACE, so the server is pid 1 to it: `/proc/1/stat` (CPU),
# `/proc/1/status` (resident memory), `/proc/1/io` (bytes written) and, in
# separate untimed passes, `strace -c` on every thread (fsync calls). The
# client reaches the server the way a device does: through Caddy, over TLS, on
# the Compose network. Nothing is added to the server's own image.
#
# THE ONE TOOL IT ADDS is strace, fetched as the Debian trixie package by URL
# and refused unless its SHA-256 matches the pin below (requirement 5), then
# installed into a throwaway image built FROM the digest-pinned Python image.
# The pins came from the Debian archive's own Packages index for trixie/main,
# 2026-09-26; the amd64 build links libunwind8, pinned the same way.
#
#   OBSYNC_BENCH_SCALE=full   B1 10,000 notes, B3 2 GiB, 60 s idle windows (nightly)
#   OBSYNC_BENCH_SCALE=smoke  B1 1,000 notes, B3 256 MiB, 20 s idle windows (pull requests)
#
# It never writes to the repository. The results -- `bench.json` and
# `bench.md` -- land in the directory given as the second argument, which the
# workflow uploads as a run artifact.
#
# Requires: docker (with the compose plugin), curl, python3.
set -euo pipefail

usage() {
  printf 'usage: %s <obsync-image-reference> <results-directory>\n' "${0##*/}" >&2
}
if [ "$#" -ne 2 ] || [ -z "${1:-}" ] || [ -z "${2:-}" ]; then
  usage
  exit 2
fi
image="$1"
results="$2"

here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "${here}/../.." && pwd)"
readonly COMPOSE_FILE="${root}/deploy/compose/docker-compose.yml"
readonly PYTHON_IMAGE='docker.io/library/python:3.13-slim-trixie@sha256:7c61056e61ac89e852de05f3dc6fa51a6dd2181797bceed46aa725dd7cb2cd3b'
readonly DEBIAN='https://deb.debian.org/debian/pool/main'
readonly STRACE_AMD64="s/strace/strace_6.13+ds-1_amd64.deb cae290b67cf835350a2cde58ca332256fba475784b3e02a9a8677d73eaf47511"
readonly LIBUNWIND_AMD64="libu/libunwind/libunwind8_1.8.1-0.1_amd64.deb db21a86dd05c93413f0ef36282a9c64d32410d240f332273a53be1408bec1f62"
readonly STRACE_ARM64="s/strace/strace_6.13+ds-1_arm64.deb d793af70a104eb0bd5be466c3043b512f549e7cb27971320a7c9b8f4c6165e55"

case "${OBSYNC_BENCH_SCALE:-full}" in
  full) scale=(--files 10000 --fsync-files 500 --rounds 30 --b3-bytes 2147483648 --idle-secs 60) ;;
  smoke) scale=(--files 1000 --fsync-files 200 --rounds 10 --b3-bytes 268435456 --idle-secs 20) ;;
  *) printf 'bench: OBSYNC_BENCH_SCALE must be full or smoke\n' >&2; exit 2 ;;
esac

run_id="$(printf '%s' "${OBSYNC_E2E_RUN_ID:-$$-${RANDOM}}" | tr -c '[:alnum:]_-' '-')"
readonly PROJECT="obsync-e2e-${run_id}"
readonly OBSYNC_CONTAINER="${PROJECT}-obsync-1"
readonly CADDY_CONTAINER="${PROJECT}-caddy-1"
readonly PROBE_IMAGE="${PROJECT}-probe"
readonly HOST='obsync-bench.invalid'
readonly HTTP_PORT=18380
readonly HTTPS_PORT=18743
readonly READY_BUDGET_SECONDS=120

scratch="$(mktemp -d "${TMPDIR:-/tmp}/bench.XXXXXX")"
created=''
started_at="$(date +%s)"

# The compose file pins its subnet, so a host already running the documented
# deployment cannot run this beside it. `OBSYNC_BENCH_COMPOSE_OVERRIDE` names
# an override file that moves the subnet and the server's trust list together;
# a runner never needs one.
overrides=()
if [ -n "${OBSYNC_BENCH_COMPOSE_OVERRIDE:-}" ]; then
  overrides=(--file "${OBSYNC_BENCH_COMPOSE_OVERRIDE}")
fi
compose() {
  docker compose --project-name "${PROJECT}" --file "${COMPOSE_FILE}" "${overrides[@]}" "$@"
}

deny() {
  printf 'bench: DENY %s\n' "$1" >&2
  if [ -n "${created}" ]; then
    compose logs --tail 40 >&2 2>&1 || true
  fi
  exit 1
}

cleanup() {
  local status=$?
  if [ -n "${created}" ]; then
    compose down --volumes --remove-orphans >/dev/null 2>&1 || true
    docker image rm --force "${PROBE_IMAGE}" >/dev/null 2>&1 || true
  fi
  rm -rf -- "${scratch}"
  return "${status}"
}

export OBSYNC_IMAGE="${image}" OBSYNC_HOST="${HOST}" OBSYNC_BIND_ADDRESS=127.0.0.1
export OBSYNC_HTTP_PORT="${HTTP_PORT}" OBSYNC_HTTPS_PORT="${HTTPS_PORT}"
# B3 stores 2 GiB, and the watermark is the larger of 5 % and 2 GiB of the
# DECLARED capacity (docs/storage.md), so the declaration has to clear both.
export OBSYNC_BLOBS_CAPACITY=16GiB OBSYNC_JOURNAL_CAPACITY=4GiB

printf 'bench: START image=%s scale=%s project=%s results=%s\n' \
  "${image}" "${OBSYNC_BENCH_SCALE:-full}" "${PROJECT}" "${results}"

docker compose version >/dev/null 2>&1 || deny 'docker compose is not available'
docker image inspect "${image}" >/dev/null 2>&1 || deny "no local image ${image}; this script builds nothing"
! docker container inspect "${OBSYNC_CONTAINER}" >/dev/null 2>&1 || deny "${OBSYNC_CONTAINER} already exists"
mkdir -p "${results}"
trap cleanup EXIT

# The probe image: Python, plus strace from its pinned Debian packages. Every
# package is verified before any is installed, and all go to one `dpkg -i`:
# the amd64 strace depends on libunwind8, and installed alone first it was
# refused. The build's own words are kept for a refusal (requirement 12).
created='probe'
docker build --progress=plain --tag "${PROBE_IMAGE}" - >"${scratch}/probe.log" 2>&1 <<DOCKERFILE \
  || { tail -n 40 "${scratch}/probe.log" >&2; deny 'the probe image would not build'; }
FROM ${PYTHON_IMAGE}
RUN set -eu; mkdir /tmp/pins; cd /tmp/pins; \
    case "\$(dpkg --print-architecture)" in \
      amd64) pins="${STRACE_AMD64};${LIBUNWIND_AMD64}" ;; \
      arm64) pins="${STRACE_ARM64}" ;; \
      *) echo "no strace pin for \$(dpkg --print-architecture)" >&2; exit 1 ;; \
    esac; \
    echo "\${pins}" | tr ';' '\n' | while read -r path sha; do \
      name="\${path##*/}"; \
      python3 -c 'import sys, urllib.request; urllib.request.urlretrieve(sys.argv[1], sys.argv[2])' "${DEBIAN}/\${path}" "\${name}"; \
      echo "\${sha}  \${name}" | sha256sum -c - ; \
    done; \
    dpkg -i ./*.deb; cd /; rm -rf /tmp/pins; \
    strace -V | head -n 1
DOCKERFILE

created='project'
compose up -d >"${scratch}/up.log" 2>&1 || { cat "${scratch}/up.log" >&2; deny 'compose up failed'; }
ready=''
for _ in $(seq 1 "${READY_BUDGET_SECONDS}"); do
  if [ ! -s "${scratch}/root.crt" ]; then
    docker cp "${CADDY_CONTAINER}:/data/caddy/pki/authorities/local/root.crt" "${scratch}/root.crt" >/dev/null 2>&1 || true
  fi
  if [ -s "${scratch}/root.crt" ]; then
    body="$(curl --silent --max-time 3 --cacert "${scratch}/root.crt" \
      --resolve "${HOST}:${HTTPS_PORT}:127.0.0.1" "https://${HOST}:${HTTPS_PORT}/readyz" 2>/dev/null || true)"
    case "${body}" in '{"ready":true'*) ready="${body}"; break ;; esac
  fi
  sleep 1
done
[ -n "${ready}" ] || deny "no {\"ready\":true through Caddy within ${READY_BUDGET_SECONDS}s"
printf 'bench: ready %s\n' "${ready}"

umask 077
docker exec "${OBSYNC_CONTAINER}" /usr/local/bin/obsyncd setup-token > "${scratch}/token" 2>/dev/null \
  || deny 'the server would not print its setup token'
if [ -n "${GITHUB_ACTIONS:-}" ]; then
  printf '::add-mask::%s\n' "$(tr -d '[:space:]' < "${scratch}/token")"
fi
umask 022
chmod 0755 "${scratch}"
chmod 0644 "${scratch}/root.crt"

# The client, in the server's PID namespace and on its Compose network. Root,
# because reading another user's /proc/<pid>/io and attaching strace take
# CAP_SYS_PTRACE, which Docker grants only to root; DAC_OVERRIDE so that root
# can write its results into a directory the runner's user owns.
docker run --rm --interactive \
  --network "${PROJECT}_obsync" --pid "container:${OBSYNC_CONTAINER}" \
  --cap-drop ALL --cap-add SYS_PTRACE --cap-add DAC_OVERRIDE --security-opt no-new-privileges \
  --volume "${here}:/ci:ro" --volume "${scratch}:/work" --volume "$(cd "${results}" && pwd):/results" \
  "${PROBE_IMAGE}" python3 -B /ci/api_flow.py bench \
  --host "${HOST}" --port 443 --address caddy --cacert /work/root.crt --state /work/devices.json \
  --proc /proc/1 --strace --results /results/bench.json "${scale[@]}" < "${scratch}/token" \
  || deny 'the bench run failed'

python3 -B - "${results}/bench.json" "${image}" > "${results}/bench.md" <<'TABLE' || deny 'could not render the results table'
import json, sys
document = json.load(open(sys.argv[1]))
meta, rows = document["meta"], document["scenarios"]
print(f"obsync bench, image `{sys.argv[2]}`, {meta['machine']}, {meta['cpus']} CPUs, kernel {meta['kernel']}, {meta['started']}\n")
print("| scenario | result | server CPU s | server writes MiB | server RSS MiB (peak) | fsyncs |")
print("| --- | --- | --- | --- | --- | --- |")
def result(name, row):
    if name == "b1":
        return f"{row['files']} x {row['file_bytes']} B in {row['wall_s']} s ({row['files_per_s']} files/s)"
    if name == "b1-fsyncs":
        return f"{row['files']} files: {row['fsyncs_per_file']} fsync per file, {row['fsyncs_per_request']} per request"
    if name == "b2":
        return f"edit to observe, {row['rounds']} rounds: p50 {row['p50_ms']} ms, p95 {row['p95_ms']} ms"
    if name == "b3":
        return (f"{row['bytes'] // 2**20} MiB up {row['upload_mib_s']} MiB/s, down {row['download_mib_s']} MiB/s; "
                f"server RSS during {row['server_rss_during_peak_mib']} MiB, client {row['client_rss_peak_mib']} MiB")
    return f"idle {row['idle_s']} s"
for name, row in rows.items():
    fsyncs = sum(row["fsyncs"].values()) if "fsyncs" in row else "-"
    print(f"| {name} | {result(name, row)} | {row.get('server_cpu_s', '-')} | {row.get('server_write_mib', '-')} "
          f"| {row.get('server_rss_mib', '-')} ({row.get('server_rss_peak_mib', '-')}) | {fsyncs} |")
TABLE
cat "${results}/bench.md"

compose down --volumes --remove-orphans >/dev/null 2>&1 || deny 'compose down failed'
docker image rm --force "${PROBE_IMAGE}" >/dev/null 2>&1 || true
created=''
printf 'bench: SUMMARY image=%s scale=%s duration=%ds decision=pass\n' \
  "${image}" "${OBSYNC_BENCH_SCALE:-full}" "$(( $(date +%s) - started_at ))"
