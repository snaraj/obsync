#!/usr/bin/env bash
# compose-e2e -- run the COMMANDS docs/server.md SHOWS, against the image this
# commit builds, and prove the first-boot credential path works end to end.
#
# WHY THIS EXISTS, BESIDE compose-smoke.sh. The smoke proves the compose FILE:
# the bind address is required, the ports are published where they were chosen,
# the origin publishes nothing, both containers are hardened. It runs commands
# of its own to do that. What nothing proved was the PAGE -- the three blocks a
# stranger actually pastes -- and the credential path those blocks exist for:
# read the setup token, sign in to the dashboard with it, and find the API
# closed to a request that carries no signature. A guide is a security surface
# (scripts/ci/test_onboarding_contract.py says why), and the only way its text
# can be trusted is for CI to run THAT text.
#
# So every command below that a reader would paste is READ OUT OF
# docs/server.md at this commit by scripts/ci/docs_blocks.py, with the three
# values a reader supplies for themselves -- the digest, the hostname, the bind
# address -- substituted by name. A page edited without its gate fails here:
# the substitution no longer matches the text and the extractor refuses.
#
# WHAT IT PROVES, in the order a first deployment meets them:
#
#   1. preflight     the compose file, the docker compose plugin, the image
#                    this run was given, two free host ports, and NO project
#                    called `obsync` already standing -- the documented
#                    command takes the project name out of the compose file,
#                    so the container names the other two blocks use are
#                    `obsync-obsync-1` and `obsync-caddy-1` exactly.
#   2. the page's up the `<!-- ci: compose-up -->` block brings the deployment
#                    up. Not a copy of it: the block.
#   3. the page's    the `<!-- ci: compose-root-certificate -->` block exports
#      certificate   the authority Caddy generated, which is what makes the
#                    HTTPS below verifiable without trusting anything on this
#                    machine.
#   4. readiness     `/readyz` answers `{"ready":true` through the terminator,
#                    validated against that root, within the stated budget.
#   5. the page's    the `<!-- ci: compose-setup-token -->` block reads 64
#      token read    lowercase hex from the container compose created. The
#                    value is masked in the runner's log before anything else
#                    happens and is never printed by this script.
#   6. the API is    `GET /v1/changes` with no signature is refused `401
#      closed        missing_auth`. That is the whole API's posture in one
#                    probe: no device credential, no data, before any account
#                    exists and after.
#   7. the token     `GET /login?token=<the token>` answers 302 and sets a
#      signs in      session; `GET /v1/admin/overview` with that session is
#                    200 and WITHOUT it is 401. So the credential the page
#                    hands a reader reaches the dashboard, and nothing else
#                    does.
#   8. it syncs      `scripts/ci/api_flow.py` enrols the account with that
#                    token, pairs a SECOND device through the API, pushes one
#                    file and reads it back from the second device, and is
#                    refused by name for a missing, altered, stale and
#                    replayed signature. A deployment that answers /readyz and
#                    cannot enrol a device is still broken for every reader of
#                    the guide.
#   9. it survives   the stack is restarted and the same two devices find the
#      a restart     file, byte for byte; a nonce spent BEFORE the restart is
#                    still refused, because the nonce log rests on the journal
#                    volume rather than in memory.
#  10. teardown      `compose down --volumes` removes both containers and the
#                    volumes, and the project is gone afterwards. It runs from
#                    a trap, so a failure at any step above cleans up too.
#
# IT BUILDS NOTHING. The image reference is the argument, so the workflow
# smokes the exact bytes it just built. The only image fetched is the
# terminator, by digest, out of the compose file -- the same anonymous pull
# compose-smoke.sh makes.
#
# HOST PORTS. This run publishes an unprivileged pair through
# `OBSYNC_HTTP_PORT` and `OBSYNC_HTTPS_PORT`, which the compose file offers for
# exactly this reason: a privileged port bound to a SPECIFIC host address is
# unavailable to an unprivileged Docker Desktop, and a gate an author cannot
# run is not a gate. `scripts/ci/compose-smoke.sh` property 2 is what proves
# the file still DEFAULTS to 80 and 443.
#
# Requires: docker (with the compose plugin), curl, tar, python3.
set -euo pipefail

usage() {
  printf 'usage: %s <obsync-image-reference>\n' "${0##*/}" >&2
  printf '  Runs the commands docs/server.md shows against that image.\n' >&2
}

if [ "$#" -ne 1 ] || [ -z "${1:-}" ]; then
  usage
  exit 2
fi
image="$1"

here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "${here}/../.." && pwd)"
readonly GUIDE='docs/server.md'
readonly COMPOSE_FILE="${root}/deploy/compose/docker-compose.yml"
# EVERY object this invocation creates carries a run id, so nothing this script
# removes can be anybody else's. The compose file names its project `obsync`
# and the documented command passes no `--project-name`, so a run that took
# that name would own -- and tear down, volumes included -- a self-hoster's
# actual deployment if one stood on the same host. `COMPOSE_PROJECT_NAME` takes
# precedence over the file's own `name:`, so the documented command still runs
# verbatim and lands in a project of this run's own; the two container names it
# decides are substituted into the blocks that read them.
#
# `OBSYNC_E2E_RUN_ID` lets a workflow name the same objects in its always()
# cleanup. Off a runner the pid and a random word are enough, and `tr` keeps
# whatever arrives inside the character set compose accepts for a project.
run_id="$(printf '%s' "${OBSYNC_E2E_RUN_ID:-$$-${RANDOM}}" | tr -c '[:alnum:]_-' '-')"
readonly PROJECT="obsync-e2e-${run_id}"
readonly OBSYNC_CONTAINER="${PROJECT}-obsync-1"
readonly CADDY_CONTAINER="${PROJECT}-caddy-1"
export COMPOSE_PROJECT_NAME="${PROJECT}"
# `.invalid` is reserved by RFC 2606 and can never resolve, so `--resolve`
# below is demonstrably the only reason the name works.
readonly HOST='obsync-e2e.invalid'
readonly BIND_ADDRESS='127.0.0.1'
# A DIFFERENT pair from `scripts/ci/compose-smoke.sh`'s 18080/18443, on
# purpose: the two run on the same machine during `make image`, and a gate
# that cannot run beside its sibling is a gate somebody skips.
readonly HTTP_PORT=18180
readonly HTTPS_PORT=18543
# Requirement 12: every wait names the budget it is measured against.
readonly READY_BUDGET_SECONDS=120
# Declared capacities, not reservations: a docker volume reserves nothing and
# the server computes free space as declared capacity minus tracked usage
# (docs/storage.md, "Free-space watermark and quota"). They must clear the
# watermark, which is the LARGER of 5 % and 2 GiB -- a volume declared under
# 2 GiB is full before the first write, and every write is refused
# `507 journal_full` with nothing wrong anywhere else.
readonly BLOBS_CAPACITY='8GiB'
readonly JOURNAL_CAPACITY='4GiB'
readonly HEX='^[0-9a-f]{64}$'

scratch="$(mktemp -d "${TMPDIR:-/tmp}/compose-e2e.XXXXXX")"
# Empty until the instant before the documented `up` runs, which covers a
# PARTIAL creation too: a failed `up` can still have made a network, a volume
# or one container. Teardown and the refusal diagnostics both read it, and the
# EXIT trap is armed only after preflight has refused every reason not to
# start, so a preflight refusal cannot reach either.
created=''
started_at="$(date +%s)"
step_at="${started_at}"

proven=0
prove() {
  local now
  now="$(date +%s)"
  proven=$((proven + 1))
  printf 'compose-e2e: (%d) %s [%ds]\n' "${proven}" "$1" "$((now - step_at))"
  step_at="${now}"
}

compose() {
  docker compose --project-name "${PROJECT}" --file "${COMPOSE_FILE}" "$@"
}

deny() {
  printf 'compose-e2e: DENY %s\n' "$1" >&2
  # Diagnostics are about THIS run's deployment. Before it exists there is
  # nothing of ours to describe, and describing somebody else's is not this
  # script's business.
  if [ -n "${created}" ]; then
    printf 'compose-e2e: --- compose ps ---\n' >&2
    compose ps --all >&2 2>&1 || true
    printf 'compose-e2e: --- service logs ---\n' >&2
    compose logs --tail 60 >&2 2>&1 || true
  fi
  rm -rf -- "${scratch}"
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

# The documented text, with this run's values substituted by name. It is the
# ONE place any documented command enters this script: nothing below writes a
# second copy of a command the page shows, so the two cannot drift apart.
documented() {
  python3 -B "${here}/docs_blocks.py" "${GUIDE}" "$@"
}

# The one `eval` in this file, and what it runs is the text of a reviewed file
# in this repository at the commit under test -- never input from anywhere
# else. Running it is the entire point: a command CI rewrites is a command the
# page no longer proves.
run_documented() {
  local text="$1"
  # The announcement goes to STANDARD ERROR: a caller that captures the
  # command's output -- the token read does -- must capture the command's
  # output and nothing of this script's.
  printf 'compose-e2e: running, from %s:\n%s\n' "${GUIDE}" "${text}" >&2
  eval "${text}"
}

# Exported for `compose down` in the trap and for `compose logs` in `deny`:
# the assignments the documented command carries apply to that command alone,
# and a variable missing on teardown leaves the project standing.
export OBSYNC_IMAGE="${image}"
export OBSYNC_HOST="${HOST}"
export OBSYNC_BIND_ADDRESS="${BIND_ADDRESS}"
export OBSYNC_HTTP_PORT="${HTTP_PORT}"
export OBSYNC_HTTPS_PORT="${HTTPS_PORT}"
export OBSYNC_BLOBS_CAPACITY="${BLOBS_CAPACITY}"
export OBSYNC_JOURNAL_CAPACITY="${JOURNAL_CAPACITY}"

printf 'compose-e2e: START image=%s guide=%s project=%s host=%s bind=%s:%d,%d ready_budget=%ds\n' \
  "${image}" "${GUIDE}" "${PROJECT}" "${HOST}" "${BIND_ADDRESS}" "${HTTP_PORT}" "${HTTPS_PORT}" \
  "${READY_BUDGET_SECONDS}"

# (1) Preflight.
[ -f "${COMPOSE_FILE}" ] || deny "no compose file at ${COMPOSE_FILE}"
docker compose version >/dev/null 2>&1 \
  || deny 'docker compose is not available; this script builds and installs nothing'
docker image inspect "${image}" >/dev/null 2>&1 \
  || deny "no local image ${image}; this script builds nothing"
for name in "${OBSYNC_CONTAINER}" "${CADDY_CONTAINER}"; do
  if docker container inspect "${name}" >/dev/null 2>&1; then
    deny "a container called ${name} already exists; the documented commands name it, so this run would read somebody else's deployment"
  fi
done
for port in "${HTTP_PORT}" "${HTTPS_PORT}"; do
  if (exec 3<>"/dev/tcp/127.0.0.1/${port}") 2>/dev/null; then
    deny "something is already listening on 127.0.0.1:${port}"
  fi
done
# The compose file PINS its subnet, because `OBSYNC_TRUSTED_PROXY_CIDRS` has to
# equal it. Two obsync deployments therefore cannot share a host, and the
# refusal docker raises for that ("Pool overlaps with other one on this address
# space") names neither deployment. Requirement 12: say which subnet, and which
# network already holds it, before anything is created.
subnet="$(awk '/- subnet:/{print $3; exit}' "${COMPOSE_FILE}")"
[ -n "${subnet}" ] || deny "the compose file declares no subnet, so this preflight cannot tell whether one is free"
holder="$(docker network ls --quiet \
  | xargs -r docker network inspect \
      --format '{{range .IPAM.Config}}{{if eq .Subnet "'"${subnet}"'"}}{{$.Name}}{{end}}{{end}}' \
  | grep -v '^$' | head -n 1 || true)"
[ -z "${holder}" ] \
  || deny "the docker network ${holder} already holds ${subnet}, the subnet the compose file pins; one host runs one obsync compose deployment"
prove "preflight: the compose file, the plugin, ${image}, free ports ${HTTP_PORT}/${HTTPS_PORT}, ${subnet} unclaimed, no ${OBSYNC_CONTAINER}, project ${PROJECT}"

# Preflight has refused every reason not to start, so from here a failure has
# something of OURS to clean up. Nothing above this line can reach the trap.
trap cleanup EXIT

# (2) The page's own `up`. The three substitutions are the three values a
# reader supplies: the digest they verified, the name their devices use, and
# the host address they publish on.
up_command="$(documented compose-up \
  --substitute "ghcr.io/snaraj/obsync@sha256:<digest>=${image}" \
  --substitute "sync.example.org=${HOST}" \
  --substitute "192.168.1.10=${BIND_ADDRESS}")" \
  || deny "docs/server.md no longer shows the compose-up block this gate substitutes into"
cd "${root}"
# Set BEFORE the command that creates anything: a half-finished `up` leaves a
# network and a volume behind, and those are ours to remove.
created='project'
run_documented "${up_command}" > "${scratch}/up.log" 2>&1 || {
  cat "${scratch}/up.log" >&2
  deny 'the documented `docker compose up` failed'
}
for name in "${OBSYNC_CONTAINER}" "${CADDY_CONTAINER}"; do
  docker container inspect "${name}" >/dev/null 2>&1 \
    || deny "the documented up created no container called ${name}"
done
prove "the page's up: ${OBSYNC_CONTAINER} and ${CADDY_CONTAINER} are running from ${GUIDE}'s own command"

# (3) and (4) The page's certificate export, then readiness through the
# terminator. The export can only succeed once Caddy has generated its
# authority, so the two share one budget.
certificate_command="$(documented compose-root-certificate \
  --substitute "obsync-caddy-1=${CADDY_CONTAINER}")" \
  || deny "docs/server.md no longer shows the root-certificate block"
printf 'compose-e2e: polling, from %s:\n%s\n' "${GUIDE}" "${certificate_command}" >&2
cd "${scratch}"
ready=''
for _ in $(seq 1 "${READY_BUDGET_SECONDS}"); do
  for name in "${OBSYNC_CONTAINER}" "${CADDY_CONTAINER}"; do
    state="$(docker container inspect --format '{{.State.Status}}' "${name}" 2>/dev/null || true)"
    [ "${state}" = running ] \
      || deny "${name} is ${state:-gone} before the deployment was ready"
  done
  if [ ! -s "${scratch}/obsync-root.crt" ]; then
    eval "${certificate_command}" 2>/dev/null || true
  fi
  if [ -s "${scratch}/obsync-root.crt" ]; then
    body="$(curl --silent --show-error --max-time 3 \
      --cacert "${scratch}/obsync-root.crt" \
      --resolve "${HOST}:${HTTPS_PORT}:127.0.0.1" \
      "https://${HOST}:${HTTPS_PORT}/readyz" 2>/dev/null || true)"
    case "${body}" in
      '{"ready":true'*)
        ready="${body}"
        break
        ;;
    esac
  fi
  sleep 1
done
[ -s "${scratch}/obsync-root.crt" ] \
  || deny "the documented root-certificate export produced nothing in ${READY_BUDGET_SECONDS}s"
prove "the page's certificate: the authority exported by ${GUIDE}'s own command is $(wc -c < "${scratch}/obsync-root.crt" | tr -d ' ') bytes"
[ -n "${ready}" ] \
  || deny "no {\"ready\":true from https://${HOST}:${HTTPS_PORT}/readyz through the terminator within ${READY_BUDGET_SECONDS}s"
prove "readiness: /readyz answered ${ready} over TLS against that root"

# A request helper, so no URL carrying the token is ever built twice or
# printed. It prints the status code and writes the body to $1.
request() {
  local body="$1" path="$2"
  shift 2
  curl --silent --show-error --max-time 10 \
    --cacert "${scratch}/obsync-root.crt" \
    --resolve "${HOST}:${HTTPS_PORT}:127.0.0.1" \
    --output "${body}" --write-out '%{http_code}' \
    "$@" "https://${HOST}:${HTTPS_PORT}${path}" 2>/dev/null || true
}

# The sign-in is the ONE request whose query carries the credential, and the
# credential never reaches an ARGUMENT VECTOR. `--data-urlencode "token=…"` is
# not enough: the value is still one of curl's argv entries and sits in this
# host's process table for the life of the call, where `ps` reads it and the
# runner's `::add-mask::` -- which covers a log -- does not. So the request is
# described to curl on STDIN, in its own configuration syntax, through a pipe
# this shell owns: nothing on disk, nothing in argv, nothing another process on
# the host can list. `printf` is a bash BUILTIN, so even the write that feeds
# the pipe forks nothing.
sign_in() {
  local body="$1" cookies="$2"
  printf 'url = "https://%s:%s/login"\nget\ndata-urlencode = "token=%s"\n' \
    "${HOST}" "${HTTPS_PORT}" "${token}" \
    | curl --silent --show-error --max-time 10 \
        --cacert "${scratch}/obsync-root.crt" \
        --resolve "${HOST}:${HTTPS_PORT}:127.0.0.1" \
        --output "${body}" --write-out '%{http_code}' \
        --cookie-jar "${cookies}" \
        --config - 2>/dev/null || true
}

# (5) The page's token read. `::add-mask::` is emitted BEFORE the value is
# used anywhere, so every later line of this job's log has it redacted; the
# script itself never prints it, on success or on failure.
token_command="$(documented compose-setup-token \
  --substitute "obsync-obsync-1=${OBSYNC_CONTAINER}")" \
  || deny "docs/server.md no longer shows the setup-token block"
token="$(run_documented "${token_command}" | tr -d '[:space:]')" \
  || deny 'the documented setup-token read failed'
# The mask is the runner's, and the runner is where the value is at risk:
# GitHub redacts the value from every later line of the job's log and does not
# echo the command itself. OFF a runner nothing would consume the directive, so
# printing it would be the one place this script showed a credential.
if [ -n "${GITHUB_ACTIONS:-}" ]; then
  printf '::add-mask::%s\n' "${token}"
fi
printf '%s' "${token}" | grep -Eq "${HEX}" \
  || deny "the setup token read by the documented command is not 64 lowercase hex characters (${#token} characters read)"
prove "the page's token read: ${#token} lowercase hex characters, masked in this log and printed nowhere"

# (6) The API is closed to an unsigned request.
status="$(request "${scratch}/unsigned.json" '/v1/changes?since=0')"
[ "${status}" = 401 ] \
  || deny "an unsigned GET /v1/changes answered ${status:-nothing}, not 401"
grep -q '"error":"missing_auth"' "${scratch}/unsigned.json" \
  || deny "the 401 does not name missing_auth: $(head -c 200 "${scratch}/unsigned.json")"
prove 'the API is closed: an unsigned GET /v1/changes is 401 missing_auth'

# (7) The token signs in to the dashboard, and only a session reads it.
status="$(request "${scratch}/no-session.json" '/v1/admin/overview')"
[ "${status}" = 401 ] \
  || deny "GET /v1/admin/overview with no session answered ${status:-nothing}, not 401"
status="$(sign_in "${scratch}/login.html" "${scratch}/cookies.txt")"
[ "${status}" = 302 ] \
  || deny "the dashboard sign-in link answered ${status:-nothing}, not 302"
grep -qi 'obsync_session' "${scratch}/cookies.txt" \
  || deny 'the dashboard sign-in set no session cookie'
status="$(request "${scratch}/overview.json" '/v1/admin/overview' \
  --cookie "${scratch}/cookies.txt")"
[ "${status}" = 200 ] \
  || deny "GET /v1/admin/overview with the session answered ${status:-nothing}, not 200"
prove 'the token signs in: /login?token=… is 302 with a session, /v1/admin/overview is 200 with it and 401 without'

# (8) It syncs. The token enrols the account, a second device pairs through
# the API, one file goes up and comes back down on the other device, and every
# refusal the protocol names is refused. The token reaches the client on STDIN:
# an argument would put a credential in this runner's process table.
printf '%s' "${token}" | python3 -B "${here}/api_flow.py" enroll \
  --host "${HOST}" --port "${HTTPS_PORT}" --address 127.0.0.1 \
  --cacert "${scratch}/obsync-root.crt" --state "${scratch}/devices.json" \
  || deny 'the documented deployment could not carry the sync flow'
prove 'it syncs: first boot, a second device paired, one file pushed and pulled, four refusals by name'

# (9) It survives a restart. Persistence is the property a deployment guide is
# really making a promise about: the volumes the page tells a reader to back up
# are the ones that must bring the account, the devices and the data back.
compose restart >/dev/null 2>&1 || deny 'compose restart failed'
ready=''
for _ in $(seq 1 "${READY_BUDGET_SECONDS}"); do
  body="$(curl --silent --show-error --max-time 3 \
    --cacert "${scratch}/obsync-root.crt" \
    --resolve "${HOST}:${HTTPS_PORT}:127.0.0.1" \
    "https://${HOST}:${HTTPS_PORT}/readyz" 2>/dev/null || true)"
  case "${body}" in
    '{"ready":true'*)
      ready="${body}"
      break
      ;;
  esac
  sleep 1
done
[ -n "${ready}" ] \
  || deny "the deployment did not answer {\"ready\":true again within ${READY_BUDGET_SECONDS}s of the restart"
python3 -B "${here}/api_flow.py" verify \
  --host "${HOST}" --port "${HTTPS_PORT}" --address 127.0.0.1 \
  --cacert "${scratch}/obsync-root.crt" --state "${scratch}/devices.json" \
  || deny 'the restarted deployment lost the account, the devices or the data'
prove "it survives a restart: /readyz answered ${ready} again, the file and both devices came back, and a nonce spent before the restart is still refused"

# (10) Teardown, proven rather than assumed. The trap runs it again and finds
# nothing, which is what an always-run cleanup is for.
cd "${root}"
compose down --volumes --remove-orphans >/dev/null 2>&1 \
  || deny 'compose down failed'
remaining="$(compose ps --all --quiet | grep -c '' || true)"
[ "${remaining}" -eq 0 ] \
  || deny "${remaining} container(s) of project ${PROJECT} survived compose down"
created=''
prove "teardown: project ${PROJECT} is gone, volumes included"

printf 'compose-e2e: SUMMARY image=%s guide=%s steps=%d duration=%ds decision=pass\n' \
  "${image}" "${GUIDE}" "${proven}" "$(( $(date +%s) - started_at ))"
