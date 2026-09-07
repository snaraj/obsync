#!/usr/bin/env bash
# image-smoke -- run the SHIPPED image the way the README tells a stranger to
# run it, and prove the five properties that quick start depends on.
#
# WHY THIS EXISTS. The `container` job proved the image BUILDS and that its
# config says `User=nonroot`. Neither fact requires the image to work. With two
# fresh named volumes -- the README's first command, and every first
# deployment there will ever be -- the shipped image exited immediately:
#
#   event=server_key_failed decision=exit refusal=io_error
#
# because the final stage declared `USER nonroot` without creating
# /data/blobs or /data/journal, so the daemon created those mount points
# root-owned and the runtime uid could write neither its server key nor the
# setup token. Every static check in the gate was green while the documented
# path from nothing to a running server could not complete once.
#
# WHAT IT PROVES, in the order a first deployment meets them:
#
#   1. readiness      /readyz answers {"ready":true — the server bound its
#                     port, opened both volumes, and replayed the journal
#                     (AGENTS.md requirement 7 makes that answer truthful, so
#                     it is worth polling).
#   2. runtime uid    the process is still alive and running as 65532, from
#                     OUTSIDE the container, because distroless has no shell
#                     to ask inside. `User=nonroot` in the image config is a
#                     name; this is the number the volumes were chowned to.
#   3. token, running the README's exact `docker cp … | tar -xO` reads a
#                     64-lowercase-hex setup token off the journal volume.
#                     That is the ONE credential the first device needs, and
#                     the assertion that the volume was writable at all.
#   4. token, stopped the same command works on a STOPPED container. The
#                     README promises "running or stopped" and `docker cp`
#                     against a stopped container is a different daemon path.
#   5. hardening      all of it under --read-only, --cap-drop ALL and
#                     --security-opt no-new-privileges, which is the chart's
#                     rendered container security context expressed in the
#                     one place a `docker run` reader can see it. A regression
#                     that needs a capability or a writable root filesystem
#                     fails here rather than on the owner's Pi.
#
# It BUILDS NOTHING. The image reference is the argument, so the gate smokes
# the exact bytes it just built and `make image` smokes the exact bytes it just
# built, and neither can drift into smoking something else.
#
# Requires: docker, curl, tar. No registry access: the image is already local.
set -euo pipefail

usage() {
  printf 'usage: %s <image-reference>\n' "${0##*/}" >&2
  printf '  Runs the image with two fresh volumes and proves it serves.\n' >&2
}

if [ "$#" -ne 1 ] || [ -z "${1:-}" ]; then
  usage
  exit 2
fi
image="$1"

# The README's own capacities are hundreds of gigabytes; these are the smallest
# values that configure the same code paths on a laptop or a CI runner.
readonly BLOBS_CAPACITY='1GiB'
readonly JOURNAL_CAPACITY='256MiB'
# Requirement 12: every wait states the budget it is measured against.
readonly READY_BUDGET_SECONDS=60
readonly TOKEN_PATH='/data/journal/v1/setup-token'

run_id="$$-${RANDOM}"
container="obsync-smoke-${run_id}"
restored="${container}-restored"
blobs_volume="obsync-smoke-blobs-${run_id}"
journal_volume="obsync-smoke-journal-${run_id}"
started_at="$(date +%s)"

proven=0
prove() {
  proven=$((proven + 1))
  printf 'image-smoke: (%d) %s\n' "${proven}" "$1"
}

deny() {
  printf 'image-smoke: DENY %s\n' "$1" >&2
  # The refusal is worth nothing without the server's own account of it, and
  # this is the one place that account exists: the container is about to be
  # removed by the trap.
  local name
  for name in "${container}" "${restored}"; do
    if docker container inspect "${name}" >/dev/null 2>&1; then
      printf 'image-smoke: --- container logs (%s) ---\n' "${name}" >&2
      docker logs "${name}" >&2 2>&1 || true
      printf 'image-smoke: --- container state (%s) ---\n' "${name}" >&2
      docker container inspect --format \
        'status={{.State.Status}} exit={{.State.ExitCode}} error={{.State.Error}}' \
        "${name}" >&2 || true
    fi
  done
  exit 1
}

cleanup() {
  local status=$?
  docker rm --force "${container}" "${restored}" >/dev/null 2>&1 || true
  docker volume rm --force "${blobs_volume}" "${journal_volume}" >/dev/null 2>&1 || true
  return "${status}"
}
trap cleanup EXIT

printf 'image-smoke: START image=%s ready_budget=%ds volumes=%s,%s\n' \
  "${image}" "${READY_BUDGET_SECONDS}" "${blobs_volume}" "${journal_volume}"

docker image inspect "${image}" >/dev/null 2>&1 \
  || deny "no local image ${image}; this script builds nothing"

# FRESH volumes, uniquely named: the whole finding lives in what a brand new
# volume inherits from the image, so reusing one would prove the opposite of
# what is wanted here.
docker volume create "${blobs_volume}" >/dev/null
docker volume create "${journal_volume}" >/dev/null

# Port 0 on the host: the DAEMON picks a free port and tells us which, so two
# concurrent runs -- or anything else already listening -- cannot collide, and
# there is no window between choosing a port and binding it. Bound to the
# loopback address only; nothing here is reachable off the host.
docker run --detach --name "${container}" \
  --publish '127.0.0.1::8080' \
  --read-only \
  --cap-drop ALL \
  --security-opt no-new-privileges \
  --volume "${blobs_volume}:/data/blobs" \
  --volume "${journal_volume}:/data/journal" \
  --env "OBSYNC_BLOBS_CAPACITY=${BLOBS_CAPACITY}" \
  --env "OBSYNC_JOURNAL_CAPACITY=${JOURNAL_CAPACITY}" \
  "${image}" >/dev/null

# The status is asked FIRST, and not only because the loop below asks it too:
# a container that has already exited has no published port either, and
# "published no port" would name the symptom while the logs printed by `deny`
# name the cause. The refusal should agree with them.
status="$(docker container inspect --format '{{.State.Status}}' "${container}")"
[ "${status}" = running ] \
  || deny "the container is ${status} moments after docker run; it never served"
published="$(docker port "${container}" 8080/tcp | head -n 1)" \
  || deny 'the container published no port for 8080/tcp'
[ -n "${published}" ] || deny 'the container published no port for 8080/tcp'

# (1) Readiness, within the stated budget.
ready=''
for _ in $(seq 1 "${READY_BUDGET_SECONDS}"); do
  status="$(docker container inspect --format '{{.State.Status}}' "${container}" 2>/dev/null || true)"
  if [ "${status}" != running ]; then
    deny "the container stopped before it was ready (status=${status:-gone})"
  fi
  body="$(curl --silent --show-error --max-time 2 "http://${published}/readyz" 2>/dev/null || true)"
  case "${body}" in
    '{"ready":true'*)
      ready="${body}"
      break
      ;;
  esac
  sleep 1
done
[ -n "${ready}" ] \
  || deny "no {\"ready\":true from http://${published}/readyz within ${READY_BUDGET_SECONDS}s"
ready_seconds=$(( $(date +%s) - started_at ))
prove "readiness: GET /readyz answered ${ready} after ${ready_seconds}s of a ${READY_BUDGET_SECONDS}s budget"

# (2) Still running, as the runtime uid, asked from outside. `docker top`
# reports the HOST's view of the process table, which is the only view
# available: the image has no shell, no `id`, and nothing else to exec.
status="$(docker container inspect --format '{{.State.Status}}' "${container}")"
[ "${status}" = running ] || deny "the container is ${status}, not running, after answering ready"
uids="$(docker top "${container}" -o uid,pid,comm | awk 'NR > 1 {print $1}' | sort -u)"
[ -n "${uids}" ] || deny 'docker top reported no process in the container'
[ "${uids}" = '65532' ] \
  || deny "the container runs as uid(s) [$(printf '%s' "${uids}" | tr '\n' ' ')], not 65532"
prove 'runtime uid: every process in the running container is uid 65532'

# (3) The token, exactly as the README documents it: no helper image, no
# network, no shell in the container. `docker cp … -` writes a tar stream and
# `tar -xO` prints the member's bytes.
hex='^[0-9a-f]{64}$'
running_token="$(docker cp "${container}:${TOKEN_PATH}" - | tar -xO | tr -d '[:space:]')" \
  || deny "the README's read of ${TOKEN_PATH} failed on the running container"
[ -n "${running_token}" ] || deny "${TOKEN_PATH} is empty on the running container"
printf '%s' "${running_token}" | grep -Eq "${hex}" \
  || deny "the setup token is not 64 lowercase hex characters (${#running_token} characters read)"
prove "setup token: ${TOKEN_PATH} read from the running container is 64 lowercase hex characters"

# (4) The same command against a STOPPED container: a different daemon path,
# and the state an operator who has restarted their host is actually in.
docker stop -t 30 "${container}" >/dev/null \
  || deny 'the container did not stop'
status="$(docker container inspect --format '{{.State.Status}}' "${container}")"
[ "${status}" = exited ] || deny "the container is ${status} after docker stop, not exited"
stopped_token="$(docker cp "${container}:${TOKEN_PATH}" - | tar -xO | tr -d '[:space:]')" \
  || deny "the README's read of ${TOKEN_PATH} failed on the stopped container"
[ "${stopped_token}" = "${running_token}" ] \
  || deny 'the stopped container yielded a different setup token than the running one'
prove 'setup token: the same read works on the stopped container and yields the same token'

# (5) The hardening the run carried all along. Stated from the container's own
# record rather than from the flags this script passed, so a flag silently
# dropped by a future edit is a failure and not a comment.
hardening="$(docker container inspect --format \
  'readonly={{.HostConfig.ReadonlyRootfs}} capdrop={{.HostConfig.CapDrop}} capadd={{.HostConfig.CapAdd}} secopt={{.HostConfig.SecurityOpt}}' \
  "${container}")"
case "${hardening}" in
  'readonly=true capdrop=[ALL] capadd=[] secopt=[no-new-privileges]') ;;
  *) deny "the container did not run hardened: ${hardening}" ;;
esac
prove "hardening: the whole run was ${hardening}"

# (6) A RESTORED volume. Everything above proved a fresh volume; a volume
# restored from a backup, copied by hand, or bind-mounted arrives with
# whatever modes the copy gave it, and the round-8 reviewer showed a server
# that served a 0644 recovery credential while logging 0600. So: weaken what
# the first start left behind -- the real key, the real token, the real
# roots -- to exactly that shape, start the image a SECOND time on the same
# volumes, and require every class repaired, said so in the log, and read
# back at the required mode. Properties 1-5 keep their fresh-volume meaning
# because this runs after them.
#
# The throwaway that weakens the files is the compose path's own pinned
# terminator image: it has a shell and coreutils, it is already pulled by the
# compose smoke in the same job, and it is pinned by digest there. The obsync
# image is distroless and has neither.
throwaway="$(awk '$1 == "image:" && $2 ~ /^docker\.io\/library\/caddy@sha256:/ { print $2; exit }' deploy/compose/docker-compose.yml)"
[ -n "${throwaway}" ] \
  || deny 'no digest-pinned throwaway image in deploy/compose/docker-compose.yml to weaken the volumes with'
weakened="$(docker run --rm --user 0 \
  --volume "${blobs_volume}:/data/blobs" \
  --volume "${journal_volume}:/data/journal" \
  "${throwaway}" sh -c 'chmod 0755 /data/blobs/v1 /data/journal/v1 \
    && chmod 0644 /data/journal/v1/server.key /data/journal/v1/setup-token \
    && stat -c %a /data/blobs/v1 /data/journal/v1 /data/journal/v1/server.key /data/journal/v1/setup-token' \
  | tr '\n' ' ')"
[ "${weakened}" = '755 755 644 644 ' ] \
  || deny "could not weaken the restored volumes to the reviewer's shape: got '${weakened}'"
docker run --detach --name "${restored}" \
  --publish '127.0.0.1::8080' \
  --read-only \
  --cap-drop ALL \
  --security-opt no-new-privileges \
  --volume "${blobs_volume}:/data/blobs" \
  --volume "${journal_volume}:/data/journal" \
  --env "OBSYNC_BLOBS_CAPACITY=${BLOBS_CAPACITY}" \
  --env "OBSYNC_JOURNAL_CAPACITY=${JOURNAL_CAPACITY}" \
  "${image}" >/dev/null
restored_port="$(docker port "${restored}" 8080/tcp | head -n 1)" \
  || deny 'the restored container published no port for 8080/tcp'
ready=''
for _ in $(seq 1 "${READY_BUDGET_SECONDS}"); do
  status="$(docker container inspect --format '{{.State.Status}}' "${restored}" 2>/dev/null || true)"
  [ "${status}" = running ] \
    || deny "the restored container stopped before it was ready (status=${status:-gone}); a weak mode should be repaired, never served"
  body="$(curl --silent --show-error --max-time 2 "http://${restored_port}/readyz" 2>/dev/null || true)"
  case "${body}" in
    '{"ready":true'*) ready="${body}"; break ;;
  esac
  sleep 1
done
[ -n "${ready}" ] \
  || deny "no {\"ready\":true from the restored container within ${READY_BUDGET_SECONDS}s"
restored_logs="$(docker logs "${restored}" 2>&1)"
for class in blobs_root journal_root server_key setup_token; do
  printf '%s\n' "${restored_logs}" | grep -q "event=posture path_class=${class} decision=repaired" \
    || deny "the restored start did not log a repair for ${class}"
done
printf '%s\n' "${restored_logs}" | grep -q 'event=setup_token_ready.* mode=0600' \
  || deny 'the restored start did not log the token at the mode it read back (0600)'
repaired="$(docker run --rm --user 0 \
  --volume "${blobs_volume}:/data/blobs" \
  --volume "${journal_volume}:/data/journal" \
  "${throwaway}" stat -c %a /data/blobs/v1 /data/journal/v1 /data/journal/v1/server.key /data/journal/v1/setup-token \
  | tr '\n' ' ')"
[ "${repaired}" = '700 700 600 600 ' ] \
  || deny "the restored volumes read '${repaired}' after the second start, not 700 700 600 600"
docker stop --time 10 "${restored}" >/dev/null
prove 'restored volume: a second start on weakened volumes repaired blobs_root, journal_root, server_key and setup_token to 700/700/600/600, logged each repair, and logged only the mode it read back'

printf 'image-smoke: SUMMARY image=%s properties=%d duration=%ds decision=pass\n' \
  "${image}" "${proven}" "$(( $(date +%s) - started_at ))"
