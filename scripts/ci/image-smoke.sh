#!/usr/bin/env bash
# image-smoke -- run the SHIPPED image the way the README tells a stranger to
# run it, and prove the ten properties that quick start, and the deployment
# it becomes, depend on.
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
# Properties 6 to 9 come after those, each documented where it runs: a
# RESTORED volume, ONE WRITER, the PROVISIONING PRECONDITION, and a FULL blob
# volume. They are the states a deployment reaches later, and every one of
# them was a refusal that had to be true rather than a start that had to work.
#
# Property 10 is the CHART's, and it is the only one whose inputs this script
# does not choose: `helm template` renders the deployment, and the shipped
# image is started on exactly the environment that render produces. Everything
# above runs the image on values written here, so all nine could pass -- and
# did -- while the chart's own defaults rendered a capacity the server refuses
# to parse and a Service that made the kubelet inject names it exits on.
#
# It BUILDS NOTHING. The image reference is the argument, so the gate smokes
# the exact bytes it just built and `make image` smokes the exact bytes it just
# built, and neither can drift into smoking something else.
#
# Requires: docker, curl, tar, helm and python3 (property 10 renders the
# chart). No registry access: the image is already local.
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
# The size of the blob volume property 9 exhausts. Small enough to fill in a
# moment, large enough that the server's own layout fits in it with room.
readonly FULL_BLOBS_SIZE='8m'
# Requirement 12: every wait states the budget it is measured against.
readonly READY_BUDGET_SECONDS=60
readonly TOKEN_PATH='/data/journal/v1/setup-token'

run_id="$$-${RANDOM}"
container="obsync-smoke-${run_id}"
restored="${container}-restored"
holder="${container}-holder"
second="${container}-second"
unprepared="${container}-unprepared"
full="${container}-full"
charted="${container}-charted"
blobs_volume="obsync-smoke-blobs-${run_id}"
journal_volume="obsync-smoke-journal-${run_id}"
full_blobs="obsync-smoke-full-blobs-${run_id}"
full_journal="obsync-smoke-full-journal-${run_id}"
chart_blobs_volume="obsync-smoke-chart-blobs-${run_id}"
chart_journal_volume="obsync-smoke-chart-journal-${run_id}"
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
  # SPACE, which the server's own account cannot give. A volume with no room
  # left refuses every write the start makes and exits `refusal=io_error`;
  # so does a mount owned by somebody else. The log now names the kind
  # (issue #19) and this names the number behind `StorageFull`: how much room
  # the two volumes have, read from INSIDE them because the obsync image is
  # distroless and carries no `df`, and how much the daemon itself is holding,
  # because the volumes live in its filesystem and it is the one that ran out.
  # Every command here is best-effort: the account of a refusal must never
  # become a second refusal that hides the first.
  printf 'image-smoke: --- volume space ---\n' >&2
  docker run --rm --user 0 \
    --volume "${blobs_volume}:/data/blobs" \
    --volume "${journal_volume}:/data/journal" \
    "${throwaway}" df -h /data/blobs /data/journal >&2 2>&1 || true
  printf 'image-smoke: --- docker system df ---\n' >&2
  docker system df >&2 2>&1 || true
  exit 1
}

# The throwaway that reads the volumes from inside: the compose path's own
# digest-pinned terminator image. It has a shell and coreutils, the compose
# smoke in the same job has already pulled it, and it is pinned by digest
# there. Resolved HERE, beside the volume names, because `deny` reads both and
# `deny` can fire from the first assertion onwards; property (6) below uses
# the same value to weaken and re-read the volumes.
throwaway="$(awk '$1 == "image:" && $2 ~ /^docker\.io\/library\/caddy@sha256:/ { print $2; exit }' deploy/compose/docker-compose.yml)"

cleanup() {
  local status=$?
  docker rm --force "${container}" "${restored}" "${holder}" "${second}" "${unprepared}" "${full}" "${charted}" >/dev/null 2>&1 || true
  docker volume rm --force "${blobs_volume}" "${journal_volume}" "${full_blobs}" "${full_journal}" "${chart_blobs_volume}" "${chart_journal_volume}" >/dev/null 2>&1 || true
  return "${status}"
}
trap cleanup EXIT

[ -n "${throwaway}" ] \
  || deny 'no digest-pinned throwaway image in deploy/compose/docker-compose.yml to read the volumes with'

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
# The throwaway that weakens the files is the one resolved at the top, beside
# the volume names.
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

# ONE WRITER. ReadWriteOnce keeps other NODES off a volume and nothing more:
# a second container on the same host mounts the same volumes without
# complaint. The server's own exclusive lock on the journal root is what
# makes "one writer" true, so a second server on these volumes must refuse to
# start, say why, and leave the first one serving.
docker run --detach --name "${holder}" \
  --publish '127.0.0.1::8080' \
  --read-only \
  --cap-drop ALL \
  --security-opt no-new-privileges \
  --volume "${blobs_volume}:/data/blobs" \
  --volume "${journal_volume}:/data/journal" \
  --env "OBSYNC_BLOBS_CAPACITY=${BLOBS_CAPACITY}" \
  --env "OBSYNC_JOURNAL_CAPACITY=${JOURNAL_CAPACITY}" \
  "${image}" >/dev/null
holder_port="$(docker port "${holder}" 8080/tcp | head -n 1)" \
  || deny 'the first server published no port for 8080/tcp'
ready=''
for _ in $(seq 1 "${READY_BUDGET_SECONDS}"); do
  body="$(curl --silent --show-error --max-time 2 "http://${holder_port}/readyz" 2>/dev/null || true)"
  case "${body}" in
    '{"ready":true'*) ready="${body}"; break ;;
  esac
  sleep 1
done
[ -n "${ready}" ] \
  || deny "no {\"ready\":true from the first server within ${READY_BUDGET_SECONDS}s"
docker run --detach --name "${second}" \
  --read-only \
  --cap-drop ALL \
  --security-opt no-new-privileges \
  --volume "${blobs_volume}:/data/blobs" \
  --volume "${journal_volume}:/data/journal" \
  --env "OBSYNC_BLOBS_CAPACITY=${BLOBS_CAPACITY}" \
  --env "OBSYNC_JOURNAL_CAPACITY=${JOURNAL_CAPACITY}" \
  "${image}" >/dev/null
status=''
for _ in $(seq 1 "${READY_BUDGET_SECONDS}"); do
  status="$(docker container inspect --format '{{.State.Status}}' "${second}" 2>/dev/null || true)"
  [ "${status}" = exited ] && break
  sleep 1
done
[ "${status}" = exited ] \
  || deny "the second server on the same volumes is '${status:-gone}' after ${READY_BUDGET_SECONDS}s; one writer means it must refuse to start"
second_code="$(docker container inspect --format '{{.State.ExitCode}}' "${second}")"
[ "${second_code}" != 0 ] \
  || deny 'the second server on the same volumes exited 0; a refusal is not a clean start'
# The log driver can lag the exit by a moment; read the line, not the moment.
said=''
for _ in 1 2 3 4 5; do
  docker logs "${second}" 2>&1 | grep -q 'event=store_open decision=refused reason=journal_locked' && said=yes && break
  sleep 1
done
[ -n "${said}" ] \
  || { printf 'image-smoke: second server log:\n%s\nimage-smoke: first server log:\n%s\n' "$(docker logs "${second}" 2>&1)" "$(docker logs "${holder}" 2>&1 | tail -n 20)"; \
       deny 'the second server did not say why it refused (event=store_open decision=refused reason=journal_locked)'; }
body="$(curl --silent --show-error --max-time 2 "http://${holder_port}/readyz" 2>/dev/null || true)"
case "${body}" in
  '{"ready":true'*) ;;
  *) deny "the first server stopped answering while the second was refused: '${body}'" ;;
esac
docker stop --time 10 "${holder}" >/dev/null
prove 'one writer: a second container on the same volumes refused to start with reason=journal_locked, exited non-zero, and the first kept serving'

# THE PROVISIONING PRECONDITION. A storage class that presents a root-owned
# 0755 volume root holding no root of the server's is the shape a dynamic
# provisioner hands a non-root workload. The server takes ownership of
# nothing: it must refuse with the reason, not fail on the first mkdir, so
# the operator prepares the directory once and knows why.
docker run --rm --user 0 \
  --volume "${blobs_volume}:/data/blobs" \
  --volume "${journal_volume}:/data/journal" \
  "${throwaway}" sh -c 'rm -rf /data/blobs/v1 /data/journal/v1 \
    && mkdir /data/blobs/lost+found /data/journal/lost+found \
    && chown 0:0 /data/blobs /data/journal /data/blobs/lost+found /data/journal/lost+found \
    && chmod 0755 /data/blobs /data/journal' \
  || deny 'could not present the volumes as a root-owned 0755 provisioner would'
# The lost+found directories keep the volumes non-empty on purpose: Docker
# copies the image's directory, ownership included, into an EMPTY named
# volume at mount time, which would quietly re-prepare them.
docker run --detach --name "${unprepared}" \
  --read-only \
  --cap-drop ALL \
  --security-opt no-new-privileges \
  --volume "${blobs_volume}:/data/blobs" \
  --volume "${journal_volume}:/data/journal" \
  --env "OBSYNC_BLOBS_CAPACITY=${BLOBS_CAPACITY}" \
  --env "OBSYNC_JOURNAL_CAPACITY=${JOURNAL_CAPACITY}" \
  "${image}" >/dev/null
status=''
for _ in $(seq 1 "${READY_BUDGET_SECONDS}"); do
  status="$(docker container inspect --format '{{.State.Status}}' "${unprepared}" 2>/dev/null || true)"
  [ "${status}" = exited ] && break
  sleep 1
done
[ "${status}" = exited ] \
  || deny "the server on unprepared volumes is '${status:-gone}' after ${READY_BUDGET_SECONDS}s; it must refuse to start"
[ "$(docker container inspect --format '{{.State.ExitCode}}' "${unprepared}")" != 0 ] \
  || deny 'the server on unprepared volumes exited 0; a refusal is not a clean start'
said=''
for _ in 1 2 3 4 5; do
  docker logs "${unprepared}" 2>&1 | grep -q 'event=posture path_class=journal_mount decision=refused reason=unwritable' && said=yes && break
  sleep 1
done
[ -n "${said}" ] \
  || { printf 'image-smoke: unprepared server log:\n%s\n' "$(docker logs "${unprepared}" 2>&1)"; \
       deny 'the server on unprepared volumes did not say why it refused (journal_mount unwritable)'; }
docker run --rm --user 0 \
  --volume "${blobs_volume}:/data/blobs" \
  --volume "${journal_volume}:/data/journal" \
  "${throwaway}" sh -c 'test ! -e /data/journal/v1 && test ! -e /data/blobs/v1' \
  || deny 'the refused start created a root on the unprepared volumes'
prove 'provisioning precondition: root-owned 0755 volumes holding no root are refused with reason=unwritable, exit non-zero, and nothing is created'

# (9) A FULL blob volume, exhausted for real. Every property above ran with
# room, and "the watermark refuses at the declared capacity" is proven by the
# storage lane's own tests. What no test can prove is what the SHIPPED image
# does when the filesystem itself says ENOSPC: readiness is a real write to
# that volume, and it is the signal Kubernetes takes the pod out of service
# on, so it is the one an operator's cluster acts upon.
#
# The volume is a tmpfs-backed local volume rather than `--tmpfs`, and the
# difference matters: a `--tmpfs` mount belongs to one container and nothing
# else can reach it -- `docker cp` into it writes past the mount, into the
# image's own rootfs, and a `--read-only` container refuses the copy outright.
# A tmpfs-backed VOLUME is shared by every container that mounts it while it
# is mounted, so the digest-pinned throwaway can fill it and empty it again
# while the server serves, under the same hardening as every property above.
#
# NOT PROVEN HERE, deliberately: a chunk PUT over the limit. `PUT /v1/chunks
# /{sid}` is HMAC-SHA256 authenticated over method, path, timestamp, nonce and
# body hash (AGENTS.md, "Security invariants"), and this smoke has no signing
# client. Writing one in shell would mean the smoke testing a client this
# repository does not ship, which is worth less than exhausting the volume for
# real and requiring the server's own account of it and its recovery.
docker volume create --driver local --opt type=tmpfs --opt device=tmpfs \
  --opt "o=size=${FULL_BLOBS_SIZE},mode=0700,uid=65532,gid=65532" "${full_blobs}" >/dev/null \
  || deny "could not create a ${FULL_BLOBS_SIZE} blob volume to exhaust"
docker volume create "${full_journal}" >/dev/null
docker run --detach --name "${full}" \
  --publish '127.0.0.1::8080' \
  --read-only \
  --cap-drop ALL \
  --security-opt no-new-privileges \
  --volume "${full_blobs}:/data/blobs" \
  --volume "${full_journal}:/data/journal" \
  --env "OBSYNC_BLOBS_CAPACITY=${BLOBS_CAPACITY}" \
  --env "OBSYNC_JOURNAL_CAPACITY=${JOURNAL_CAPACITY}" \
  "${image}" >/dev/null
full_port="$(docker port "${full}" 8080/tcp | head -n 1)" \
  || deny 'the server on the small blob volume published no port for 8080/tcp'
ready=''
for _ in $(seq 1 "${READY_BUDGET_SECONDS}"); do
  status="$(docker container inspect --format '{{.State.Status}}' "${full}" 2>/dev/null || true)"
  [ "${status}" = running ] \
    || deny "the server on the small blob volume stopped before it was ready (status=${status:-gone})"
  body="$(curl --silent --show-error --max-time 2 "http://${full_port}/readyz" 2>/dev/null || true)"
  case "${body}" in
    '{"ready":true'*) ready="${body}"; break ;;
  esac
  sleep 1
done
[ -n "${ready}" ] \
  || deny "no {\"ready\":true from the small blob volume within ${READY_BUDGET_SECONDS}s"

# Fill it to the last byte. `dd` asks for far more than fits and stops at
# ENOSPC, so the volume is exactly full whatever its size option meant.
docker run --rm --user 0 --volume "${full_blobs}:/data/blobs" "${throwaway}" \
  sh -c 'dd if=/dev/zero of=/data/blobs/filler bs=1M count=1024 2>/dev/null; \
    test "$(df -P /data/blobs | awk "NR == 2 { print \$4 }")" -eq 0' \
  || deny 'could not exhaust the blob volume'

# The verdict is cached for a few seconds by design, so this polls rather
# than assuming; the budget is the same one readiness itself is given.
refused=''
for _ in $(seq 1 "${READY_BUDGET_SECONDS}"); do
  body="$(curl --silent --show-error --max-time 2 "http://${full_port}/readyz" 2>/dev/null || true)"
  case "${body}" in
    *'"not_ready"'*) refused="${body}"; break ;;
  esac
  sleep 1
done
[ -n "${refused}" ] \
  || deny "a full blob volume was still answering ready after ${READY_BUDGET_SECONDS}s: '${body}'"
case "${refused}" in
  *'blobs volume is not writable'*) ;;
  *) deny "the refusal did not name the volume that refused: '${refused}'" ;;
esac
# The server's own account, which is the half an operator reads. The KIND the
# filesystem returned, and no path (AGENTS.md requirements 6 and 12).
said=''
for _ in 1 2 3 4 5; do
  docker logs "${full}" 2>&1 \
    | grep -q 'event=readiness decision=not_ready volume=blobs io=StorageFull' && said=yes && break
  sleep 1
done
[ -n "${said}" ] \
  || { printf 'image-smoke: full-volume server log:\n%s\n' "$(docker logs "${full}" 2>&1 | tail -n 20)"; \
       deny 'the server did not say what the full blob volume returned (event=readiness decision=not_ready volume=blobs io=StorageFull)'; }
status="$(docker container inspect --format '{{.State.Status}}' "${full}")"
[ "${status}" = running ] \
  || deny "the server ${status} on a full volume; a full volume is a refusal, never an exit"

# And it comes back. A volume an operator has just grown, or collected, must
# make the server ready again with no restart.
docker run --rm --user 0 --volume "${full_blobs}:/data/blobs" "${throwaway}" \
  rm -f /data/blobs/filler \
  || deny 'could not free the blob volume again'
recovered=''
for _ in $(seq 1 "${READY_BUDGET_SECONDS}"); do
  body="$(curl --silent --show-error --max-time 2 "http://${full_port}/readyz" 2>/dev/null || true)"
  case "${body}" in
    '{"ready":true'*) recovered="${body}"; break ;;
  esac
  sleep 1
done
[ -n "${recovered}" ] \
  || deny "the server did not become ready again within ${READY_BUDGET_SECONDS}s of the volume being freed: '${body}'"
docker stop --time 10 "${full}" >/dev/null
prove "full blob volume: an exhausted volume answered 503 not_ready and logged io=StorageFull without exiting, and the server was ready again once the space came back"

# (10) THE CHART'S OWN ENVIRONMENT, run. Every property above configures the
# image from constants written at the top of this file, so all of them can be
# green while `helm install` renders a pod that cannot start -- which is
# exactly what happened: `chart/values.yaml` declares the claim size as the
# Kubernetes quantity `250Gi`, the deployment renders that verbatim into
# OBSYNC_BLOBS_CAPACITY, and the server had no `Gi` in its size grammar. The
# Service is called `obsync`, so a kubelet with service links on also injects
# OBSYNC_SERVICE_HOST and OBSYNC_PORT_*, and an unknown OBSYNC_* name is a
# startup error by design.
#
# So the values here come from `helm template`, READ FROM THE RENDER by
# scripts/ci/chart_pins.py through the repository's fail-closed YAML reader,
# and nothing about them is typed into this script: not a variable name, not
# a value, not the directories the volumes are mounted at. A chart edit that
# renders something the server refuses fails HERE, on the shipped bytes,
# instead of on the first `helm install` an operator runs.
#
# OBSYNC_SERVER_KEY is the one variable the render supplies from elsewhere (a
# Secret), and the server generates one at first boot when it is absent, so
# the run below omits it -- and requires it to be the ONLY such variable,
# because a second one would be a value this property silently stopped
# passing.
command -v helm >/dev/null \
  || deny 'helm is not installed; property 10 renders the chart the deployment ships'
command -v python3 >/dev/null \
  || deny 'python3 is not installed; property 10 reads the render with scripts/ci/chart_pins.py'
rendered="$(python3 -B scripts/ci/chart_pins.py env)" \
  || deny 'helm template did not render an environment the chart pins could read'

# (a) The pod spec, asserted on the render rather than on the values file.
printf '%s\n' "${rendered}" | grep -Fqx 'podSpec enableServiceLinks=false' \
  || { printf 'image-smoke: rendered environment:\n%s\n' "${rendered}" >&2; \
       deny 'the rendered pod spec does not set enableServiceLinks: false, so the kubelet would inject OBSYNC_* names the server exits on'; }

# (b) Every variable the render supplies literally, carried as rendered.
chart_env=()
while IFS= read -r line; do
  case "${line}" in
    'value '*) chart_env+=(--env "${line#value }") ;;
  esac
done <<< "${rendered}"
for name in OBSYNC_LISTEN OBSYNC_BLOBS_DIR OBSYNC_JOURNAL_DIR OBSYNC_BLOBS_CAPACITY OBSYNC_JOURNAL_CAPACITY; do
  printf '%s\n' "${rendered}" | grep -q "^value ${name}=" \
    || deny "the render carries no ${name}; property 10 would start the server on defaults it did not render"
done
supplied="$(printf '%s\n' "${rendered}" | awk '$1 == "valueFrom" { print $2 }' | sort | tr '\n' ' ')"
[ "${supplied}" = 'OBSYNC_SERVER_KEY ' ] \
  || deny "the render supplies [${supplied}] from outside the manifest; property 10 passes only the literals and the server key is the only variable it may omit"

# (c) The mount points are the render's too: the server is told where its
# volumes are, and this mounts them exactly there.
chart_blobs_dir="$(printf '%s\n' "${rendered}" | sed -n 's/^value OBSYNC_BLOBS_DIR=//p')"
chart_journal_dir="$(printf '%s\n' "${rendered}" | sed -n 's/^value OBSYNC_JOURNAL_DIR=//p')"
[ -n "${chart_blobs_dir}" ] && [ -n "${chart_journal_dir}" ] \
  || deny 'the render names no blob or journal directory'
# Property 10's own account, because `deny`'s cannot be this one: a server
# that refuses its configuration exits before it publishes a port, and
# "published no port" names the symptom while the CAUSE -- one line naming
# the variable it could not read -- is in a log nothing would have printed.
# That is the exact shape of the defect this property exists for, so it is
# also the shape its failure has to explain (AGENTS.md requirement 12).
charted_account() {
  printf 'image-smoke: --- the environment helm template rendered ---\n%s\n' "${rendered}" >&2
  printf 'image-smoke: --- the server it was given to (%s) ---\n' "${charted}" >&2
  docker logs "${charted}" >&2 2>&1 || true
  docker container inspect --format \
    'status={{.State.Status}} exit={{.State.ExitCode}} error={{.State.Error}}' \
    "${charted}" >&2 || true
}

docker volume create "${chart_blobs_volume}" >/dev/null
docker volume create "${chart_journal_volume}" >/dev/null
docker run --detach --name "${charted}" \
  --publish '127.0.0.1::8080' \
  --read-only \
  --cap-drop ALL \
  --security-opt no-new-privileges \
  --volume "${chart_blobs_volume}:${chart_blobs_dir}" \
  --volume "${chart_journal_volume}:${chart_journal_dir}" \
  "${chart_env[@]}" \
  "${image}" >/dev/null
# Asked before the port, for the same reason property 1 asks it: a container
# that has already exited has no published port either, and the refusal
# should name what the server said rather than what the daemon could not find.
status="$(docker container inspect --format '{{.State.Status}}' "${charted}")"
[ "${status}" = running ] \
  || { charted_account; deny "the shipped image is ${status} moments after starting on the environment the chart renders; it never served"; }
charted_port="$(docker port "${charted}" 8080/tcp | head -n 1)" \
  || { charted_account; deny 'the server on the chart-rendered environment published no port for 8080/tcp'; }
ready=''
for _ in $(seq 1 "${READY_BUDGET_SECONDS}"); do
  status="$(docker container inspect --format '{{.State.Status}}' "${charted}" 2>/dev/null || true)"
  [ "${status}" = running ] \
    || { charted_account; deny "the shipped image stopped before it was ready on the chart-rendered environment (status=${status:-gone})"; }
  body="$(curl --silent --show-error --max-time 2 "http://${charted_port}/readyz" 2>/dev/null || true)"
  case "${body}" in
    '{"ready":true'*) ready="${body}"; break ;;
  esac
  sleep 1
done
[ -n "${ready}" ] \
  || { charted_account; deny "no {\"ready\":true from the chart-rendered environment within ${READY_BUDGET_SECONDS}s"; }
docker stop --time 10 "${charted}" >/dev/null
prove "chart environment: the shipped image reached ${ready} on the $(( ${#chart_env[@]} / 2 )) variables helm template renders, with enableServiceLinks: false and the server key the only value the manifest supplies from elsewhere"

printf 'image-smoke: SUMMARY image=%s properties=%d duration=%ds decision=pass\n' \
  "${image}" "${proven}" "$(( $(date +%s) - started_at ))"
