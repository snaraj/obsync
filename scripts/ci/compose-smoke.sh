#!/usr/bin/env bash
# compose-smoke -- bring `deploy/compose` up and prove the PROVIDER-FREE
# install path works, over real TLS, before anybody is told to use it.
#
# WHY THIS EXISTS. AGENTS.md requirement 7 says the server always sits behind a
# TLS terminator, and requirement 1 says every provider feature the reference
# deployment uses is optional for everyone else. Between those two sentences
# sat a promise nothing tested: "any reverse proxy or tunnel elsewhere".
# `scripts/ci/image-smoke.sh` proves the image serves plain HTTP on a published
# loopback port -- which is exactly the shape iOS and Android Obsidian refuse.
# So the one deployment a stranger with a LAN and no accounts can actually
# finish was the only one with no test at all.
#
# WHAT IT PROVES, in the order a first deployment meets them:
#
#   1. bind address   the compose file REQUIRES `OBSYNC_BIND_ADDRESS` and
#                     supplies no default: `docker compose config` with it
#                     unset refuses, with the file's own message. A mapping
#                     written `80:80` publishes on every address this host
#                     has, and a private name and a private certificate
#                     authority decide naming and trust, never reachability.
#                     This is the step that keeps the choice explicit.
#   2. TLS through the proxy  `GET /readyz` answers `{"ready":true` over HTTPS,
#                     validated against the root certificate exported from the
#                     caddy container, with `--resolve` so no DNS anywhere is
#                     involved. This is the README's own path: export the root,
#                     trust it, connect by name.
#   3. origin bytes   that answer carries the server's own `X-Obsync-Seq` and
#                     the proxy's `Via`, so the 200 is obsync's and not
#                     Caddy's. A terminator that answered by itself would pass
#                     property 2 and fail here.
#   4. proxied only   the obsync container publishes NO port: its
#                     `HostConfig.PortBindings` is empty and `docker port`
#                     prints nothing, while `8080/tcp` is exposed and bound to
#                     nothing. The request in property 2 therefore reached the
#                     server across the compose network and no other way.
#   5. bound where    the caddy container's `HostConfig.PortBindings` holds
#      we chose       exactly `80/tcp` and `443/tcp`, and the `HostIp` on
#                     BOTH is the address this run selected. A bare or
#                     `0.0.0.0` host address is refused BY PORT: that is the
#                     shape a short-form `80:80` mapping produces, it is what
#                     publishes this deployment on every interface, and
#                     property 1 alone cannot see it because a deployer may
#                     still answer `0.0.0.0`.
#   6. trusted range  the server's `OBSYNC_TRUSTED_PROXY_CIDRS` equals the
#                     subnet DOCKER actually allocated for this network, and
#                     the caddy container's address on it falls inside that
#                     range -- so the forwarded address the server accepts
#                     comes from the proxy and from nothing else. This is what
#                     `0.0.0.0/0` in that variable would silently destroy, and
#                     a stale CIDR in the compose file fails here.
#   7. the server saw it  obsync's OWN log carries the `event=request
#                     path_class=/readyz status=200` line for that request.
#                     RESIDUAL, stated rather than overclaimed: this server
#                     does not log the client address (`api/mod.rs::emit`), so
#                     the DERIVATION of the forwarded address is pinned by the
#                     unit tests in `crates/obsyncd/src/api/edge.rs` and what
#                     is proven here is that the request arrived, through the
#                     proxy, from inside the trusted range.
#   8. setup token    the documented `docker cp … | tar -xO` reads 64 lowercase
#                     hex from the compose-managed container, so the credential
#                     the first device needs is reachable on this path too.
#   9. hardening      both containers ran with the security context the compose
#                     file declares, read back from Docker's record rather than
#                     from the file: obsync read-only, no capabilities, no new
#                     privileges, uid 65532; caddy read-only, no new
#                     privileges, and exactly ONE capability
#                     (`NET_BIND_SERVICE`, for the privileged-port bind), so a
#                     future edit that grants a second one fails here.
#
# The three steps that carry the deployment between those -- the preflight,
# the terminator pull and `compose up` -- log and time themselves the same way,
# so the numbers in the output run 1 to 12 and every one of them names its own
# decision.
#
# It BUILDS NOTHING. The obsync image reference is the argument, so `make
# image` and the gate's `container` job both smoke the exact bytes they just
# built. The only image it fetches is Caddy, anonymously and BY DIGEST from the
# compose file itself, retried three times with backoff because a Docker Hub
# hiccup on a runner must read as a pull failure and never as a product defect.
#
# Requires: docker (with the compose plugin), curl, tar, awk. Ports 80 and 443
# on the host's loopback address, which is what the deployment itself needs on
# whichever address it is told to publish.
set -euo pipefail

usage() {
  printf 'usage: %s <obsync-image-reference>\n' "${0##*/}" >&2
  printf '  Brings deploy/compose up with that image and proves it serves.\n' >&2
}

if [ "$#" -ne 1 ] || [ -z "${1:-}" ]; then
  usage
  exit 2
fi
image="$1"

here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "${here}/../.." && pwd)"
readonly COMPOSE_FILE="${root}/deploy/compose/docker-compose.yml"
# `.invalid` is reserved by RFC 2606 and can never resolve, so `--resolve`
# below is demonstrably the only reason the name works.
readonly HOST='obsync-smoke.invalid'
readonly TOKEN_PATH='/data/journal/v1/setup-token'
# The interface this run publishes 80 and 443 on. Loopback, because a runner
# and a laptop both have one and neither should acquire a listener on its LAN
# because a test ran. The deployment's own value is the deployer's choice; that
# it is a CHOICE at all is what properties 1 and 5 below assert.
readonly BIND_ADDRESS='127.0.0.1'
# Requirement 12: every wait names the budget it is measured against.
readonly READY_BUDGET_SECONDS=120
readonly PULL_ATTEMPTS=3
readonly PULL_BACKOFF_SECONDS=5
# Small enough to configure the same code paths on a laptop or a runner; the
# compose file's own defaults are the hundreds of gigabytes a deployment wants.
readonly BLOBS_CAPACITY='1GiB'
readonly JOURNAL_CAPACITY='256MiB'

project="obsync-smoke-$$-${RANDOM}"
scratch="$(mktemp -d "${TMPDIR:-/tmp}/compose-smoke.XXXXXX")"
started_at="$(date +%s)"
step_at="${started_at}"

proven=0
prove() {
  local now
  now="$(date +%s)"
  proven=$((proven + 1))
  printf 'compose-smoke: (%d) %s [%ds]\n' "${proven}" "$1" "$((now - step_at))"
  step_at="${now}"
}

compose() {
  docker compose --project-name "${project}" --file "${COMPOSE_FILE}" "$@"
}

deny() {
  printf 'compose-smoke: DENY %s\n' "$1" >&2
  # The refusal is worth nothing without both services' own account of it, and
  # the trap is about to remove them.
  printf 'compose-smoke: --- compose ps ---\n' >&2
  compose ps --all >&2 2>&1 || true
  printf 'compose-smoke: --- service logs ---\n' >&2
  compose logs --tail 60 >&2 2>&1 || true
  exit 1
}

cleanup() {
  local status=$?
  compose down --volumes --remove-orphans >/dev/null 2>&1 || true
  rm -rf -- "${scratch}"
  return "${status}"
}
trap cleanup EXIT

# The obsync image is the deployer's; the host is this run's. Exported because
# `docker compose` interpolates the file on `up`, on `logs` and on `down`, and
# a variable missing on teardown leaves the project standing.
export OBSYNC_IMAGE="${image}"
export OBSYNC_HOST="${HOST}"
export OBSYNC_BIND_ADDRESS="${BIND_ADDRESS}"
export OBSYNC_BLOBS_CAPACITY="${BLOBS_CAPACITY}"
export OBSYNC_JOURNAL_CAPACITY="${JOURNAL_CAPACITY}"

printf 'compose-smoke: START image=%s host=%s bind=%s project=%s ready_budget=%ds\n' \
  "${image}" "${HOST}" "${BIND_ADDRESS}" "${project}" "${READY_BUDGET_SECONDS}"

[ -f "${COMPOSE_FILE}" ] || deny "no compose file at ${COMPOSE_FILE}"
docker compose version >/dev/null 2>&1 \
  || deny 'docker compose is not available; this script builds and installs nothing'
docker image inspect "${image}" >/dev/null 2>&1 \
  || deny "no local image ${image}; this script builds nothing"

# A privileged port already in use would surface as an opaque compose failure
# ("port is already allocated") halfway through. Say it here instead, before
# anything is created. bash's own /dev/tcp is used so no netcat is required.
for port in 80 443; do
  if (exec 3<>"/dev/tcp/127.0.0.1/${port}") 2>/dev/null; then
    deny "something is already listening on 127.0.0.1:${port}; the deployment needs both 80 and 443"
  fi
done
prove 'preflight: the compose file, the docker compose plugin, the image, and ports 80 and 443'

# (1) The bind address is REQUIRED, and the message the deployer is refused
# with comes out of the compose file itself, so this step and the deployment
# can never disagree about what is being asked for. Both mappings must carry
# it: one short-form `80:80` left behind publishes that port on every host
# address while the other looks correct.
bind_requirement="$(grep -oE '\$\{OBSYNC_BIND_ADDRESS:\?[^}]+\}' "${COMPOSE_FILE}" || true)"
[ "$(printf '%s' "${bind_requirement}" | grep -c '')" -eq 2 ] \
  || deny 'the compose file does not publish both 80 and 443 through an OBSYNC_BIND_ADDRESS the deployer must supply'
bind_message="$(printf '%s\n' "${bind_requirement}" | sort -u | sed -e 's/^[^?]*?//' -e 's/}$//')"
[ "$(printf '%s' "${bind_message}" | grep -c '')" -eq 1 ] \
  || deny 'the compose file asks for OBSYNC_BIND_ADDRESS with two different messages'
# `env -u` removes exactly that one variable: the image and the hostname stay
# supplied, so a refusal here is about the bind address and about nothing else.
if env -u OBSYNC_BIND_ADDRESS docker compose --project-name "${project}" \
     --file "${COMPOSE_FILE}" config >"${scratch}/unbound.log" 2>&1; then
  deny 'docker compose resolved this file with OBSYNC_BIND_ADDRESS unset: the bind address is defaulted or optional, and a mapping with no host address publishes on every interface'
fi
grep -qF -- "${bind_message}" "${scratch}/unbound.log" \
  || deny "compose refused without OBSYNC_BIND_ADDRESS but not with the compose file's own message: $(tr '\n' ' ' < "${scratch}/unbound.log")"
prove "bind address: both mappings require OBSYNC_BIND_ADDRESS and compose refuses without it -- ${bind_message}"

# The Caddy digest comes from the COMPOSE FILE, so this pull and the deployment
# can never fetch two different things, and a tag reintroduced there is a
# missing match here rather than a silent mutable pull.
# `|| true` on every pipeline whose grep is ALLOWED to find nothing: this
# script runs under `pipefail`, so an empty grep would abort it with no
# message at all, replacing a named refusal with silence.
caddy_image="$(grep -oE 'docker\.io/library/caddy@sha256:[0-9a-f]{64}' "${COMPOSE_FILE}" | sort -u || true)"
[ "$(printf '%s' "${caddy_image}" | grep -c '')" -eq 1 ] \
  || deny 'the compose file does not pin exactly one docker.io/library/caddy@sha256 digest'
pulled=''
for attempt in $(seq 1 "${PULL_ATTEMPTS}"); do
  if docker image inspect "${caddy_image}" >/dev/null 2>&1; then
    pulled="cached"
    break
  fi
  if docker pull --quiet "${caddy_image}" >/dev/null 2>&1; then
    pulled="attempt ${attempt}"
    break
  fi
  printf 'compose-smoke: docker hub pull attempt %d/%d failed for %s; retrying in %ds\n' \
    "${attempt}" "${PULL_ATTEMPTS}" "${caddy_image}" "${PULL_BACKOFF_SECONDS}" >&2
  sleep "${PULL_BACKOFF_SECONDS}"
done
[ -n "${pulled}" ] \
  || deny "could not pull ${caddy_image} from Docker Hub in ${PULL_ATTEMPTS} attempts; this is a registry failure, not an obsync one"
prove "terminator image: ${caddy_image} present (${pulled})"

compose up --detach >"${scratch}/up.log" 2>&1 || {
  cat "${scratch}/up.log" >&2
  # Docker Desktop for Mac refuses a PRIVILEGED host port published on a
  # SPECIFIC host address unless its privileged port mapping is enabled, while
  # allowing the same port with no address at all -- which is the shape this
  # deployment deliberately no longer uses. Name that, because the daemon's own
  # sentence reads like an obsync defect and is not one.
  if grep -qF 'not allowed as current user' "${scratch}/up.log"; then
    deny "this Docker will not publish a privileged port on a specific host address as the current user, and the deployment publishes ${BIND_ADDRESS}:80 and ${BIND_ADDRESS}:443 on purpose. On Docker Desktop that is Settings > Advanced > Enable privileged port mapping; it is a host capability and not an obsync failure"
  fi
  deny 'docker compose up failed'
}
obsync_container="$(compose ps --quiet obsync)"
caddy_container="$(compose ps --quiet caddy)"
[ -n "${obsync_container}" ] || deny 'compose created no obsync container'
[ -n "${caddy_container}" ] || deny 'compose created no caddy container'
prove "up: project ${project} created both services"

# (2) TLS through the proxy, within the stated budget. The root certificate is
# exported the same way the README tells a deployer to export it, which is also
# the first thing that can only work once Caddy has generated its authority.
root_certificate="${scratch}/root.crt"
ready=''
for _ in $(seq 1 "${READY_BUDGET_SECONDS}"); do
  for name in "${obsync_container}" "${caddy_container}"; do
    state="$(docker container inspect --format '{{.State.Status}}' "${name}" 2>/dev/null || true)"
    [ "${state}" = running ] \
      || deny "a container is ${state:-gone} before the deployment was ready"
  done
  if [ ! -s "${root_certificate}" ]; then
    docker cp "${caddy_container}:/data/caddy/pki/authorities/local/root.crt" - 2>/dev/null \
      | tar -xO > "${root_certificate}" 2>/dev/null || true
  fi
  if [ -s "${root_certificate}" ]; then
    body="$(curl --silent --show-error --max-time 3 \
      --cacert "${root_certificate}" \
      --resolve "${HOST}:443:127.0.0.1" \
      --dump-header "${scratch}/headers.txt" \
      "https://${HOST}/readyz" 2>/dev/null || true)"
    case "${body}" in
      '{"ready":true'*)
        ready="${body}"
        break
        ;;
    esac
  fi
  sleep 1
done
[ -n "${ready}" ] \
  || deny "no {\"ready\":true from https://${HOST}/readyz through the proxy within ${READY_BUDGET_SECONDS}s"
prove "TLS through the proxy: https://${HOST}/readyz answered ${ready} against the exported root"

# (3) The bytes are the origin's. Header names are lowercased for HTTP/2, so
# the comparison is made on a lowercased copy.
[ -s "${scratch}/headers.txt" ] || deny 'the proxied response carried no headers to read'
headers="$(tr 'A-Z' 'a-z' < "${scratch}/headers.txt")"
case "${headers}" in
  *x-obsync-seq:*) ;;
  *) deny 'the proxied response carries no X-Obsync-Seq; it did not come from obsync' ;;
esac
case "${headers}" in
  *via:*caddy*) ;;
  *) deny 'the proxied response carries no Via naming the terminator' ;;
esac
prove 'origin bytes: the proxied 200 carries obsync X-Obsync-Seq and the proxy Via'

# (4) The origin publishes nothing. Read from Docker's record, so a `ports:`
# entry added to the obsync service fails here rather than in someone's audit.
bindings="$(docker container inspect --format '{{.HostConfig.PortBindings}}' "${obsync_container}")"
[ "${bindings}" = 'map[]' ] \
  || deny "the obsync container publishes ports: ${bindings}"
published="$(docker port "${obsync_container}" || true)"
[ -z "${published}" ] \
  || deny "the obsync container publishes ports: ${published}"
exposed="$(docker container inspect --format '{{.NetworkSettings.Ports}}' "${obsync_container}")"
[ "${exposed}" = 'map[8080/tcp:[]]' ] \
  || deny "the obsync container's port map is ${exposed}, not 8080/tcp bound to nothing"
prove 'proxied only: the obsync container publishes no port; 8080/tcp is exposed and bound to nothing'

# (5) The terminator is published where this run said, and nowhere else. Read
# from Docker's own record: this is the fact `docker compose config` cannot
# report and a `0.0.0.0` answer to property 1 would sail past.
# `awk NF` drops the empty line docker's own trailing newline leaves behind,
# and `sort` makes the comparison independent of map order.
caddy_ports="$(docker container inspect \
  --format '{{range $port, $_ := .HostConfig.PortBindings}}{{$port}}{{"\n"}}{{end}}' \
  "${caddy_container}" | sort | awk 'NF {printf "%s%s", separator, $0; separator=" "}')"
[ "${caddy_ports}" = '443/tcp 80/tcp' ] \
  || deny "the caddy container publishes ${caddy_ports:-nothing}, not exactly 80/tcp and 443/tcp"
for port in 80 443; do
  # `index` on an absent key yields nothing, and a mapping with no host address
  # yields `[]`, so both the missing port and the bare `80:80` shape are the
  # same visible mismatch here rather than a silent pass.
  bound="$(docker container inspect \
    --format "{{range index .HostConfig.PortBindings \"${port}/tcp\"}}[{{.HostIp}}]{{end}}" \
    "${caddy_container}")"
  # The two values that mean "every address this host has" are named on their
  # own, and independently of what this run selected: `[]` is what a short-form
  # `80:80` mapping records, `[0.0.0.0]` is what an explicit answer of every
  # interface records, and neither is a binding this smoke may report as proof.
  case "${bound}" in
    '[]' | '[0.0.0.0]')
      deny "the caddy container publishes ${port}/tcp on ${bound}, which is every address this host has, not one chosen interface"
      ;;
  esac
  [ "${bound}" = "[${BIND_ADDRESS}]" ] \
    || deny "the caddy container publishes ${port}/tcp on HostIp ${bound:-none}, not [${BIND_ADDRESS}]"
done
prove "bound where we chose: caddy publishes 80/tcp and 443/tcp on ${BIND_ADDRESS} and on no other address"

# (6) The trusted range is this network's range, and the proxy is inside it.
network="$(docker container inspect \
  --format '{{range $name, $_ := .NetworkSettings.Networks}}{{$name}}{{end}}' \
  "${obsync_container}")"
subnet="$(docker network inspect --format '{{range .IPAM.Config}}{{.Subnet}} {{end}}' "${network}" | tr -d ' ')"
trusted="$(docker container inspect --format '{{range .Config.Env}}{{println .}}{{end}}' \
  "${obsync_container}" | sed -n 's/^OBSYNC_TRUSTED_PROXY_CIDRS=//p' | head -n 1 || true)"
[ -n "${trusted}" ] || deny 'the obsync container declares no OBSYNC_TRUSTED_PROXY_CIDRS'
[ "${trusted}" != '0.0.0.0/0' ] \
  || deny 'OBSYNC_TRUSTED_PROXY_CIDRS is 0.0.0.0/0: every client could name its own address'
[ "${trusted}" = "${subnet}" ] \
  || deny "OBSYNC_TRUSTED_PROXY_CIDRS is ${trusted} but Docker allocated ${subnet} for ${network}"
proxy_address="$(docker container inspect \
  --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "${caddy_container}")"
[ -n "${proxy_address}" ] || deny 'the caddy container has no address on the compose network'
awk -v ip="${proxy_address}" -v cidr="${trusted}" 'BEGIN {
  if (split(cidr, c, "/") != 2) exit 1
  if (split(c[1], b, ".") != 4 || split(ip, a, ".") != 4) exit 1
  bits = c[2] + 0
  if (bits < 0 || bits > 32) exit 1
  base = 0; addr = 0
  for (i = 1; i <= 4; i++) { base = base * 256 + (b[i] + 0); addr = addr * 256 + (a[i] + 0) }
  block = 2 ^ (32 - bits)
  exit (int(addr / block) == int(base / block)) ? 0 : 1
}' || deny "the proxy address ${proxy_address} is outside the trusted range ${trusted}"
prove "trusted range: ${trusted} is the allocated subnet of ${network} and holds the proxy at ${proxy_address}"

# (7) The server's own account of the request that arrived through the proxy.
request_line="$(docker logs "${obsync_container}" 2>&1 \
  | grep -F 'event=request' | grep -F 'path_class=/readyz' | grep -F 'status=200' \
  | tail -n 1 || true)"
[ -n "${request_line}" ] \
  || deny 'the obsync log carries no served /readyz request; the proxied 200 did not come from this server'
prove "the server saw it: ${request_line}"

# (8) The setup token, read the documented way from the compose-managed
# container: no helper image, no network, no write access to the journal.
hex='^[0-9a-f]{64}$'
token="$(docker cp "${obsync_container}:${TOKEN_PATH}" - | tar -xO | tr -d '[:space:]')" \
  || deny "the documented read of ${TOKEN_PATH} failed"
printf '%s' "${token}" | grep -Eq "${hex}" \
  || deny "the setup token is not 64 lowercase hex characters (${#token} characters read)"
prove "setup token: ${TOKEN_PATH} read from the compose container is 64 lowercase hex characters"

# (9) The security context both containers actually ran with.
obsync_hardening="$(docker container inspect --format \
  'readonly={{.HostConfig.ReadonlyRootfs}} capdrop={{.HostConfig.CapDrop}} capadd={{.HostConfig.CapAdd}} secopt={{.HostConfig.SecurityOpt}} user={{.Config.User}}' \
  "${obsync_container}")"
# Docker Engine spells a capability two ways in HostConfig depending on the
# version that recorded it: Desktop 24 says `NET_BIND_SERVICE`, the runner's
# engine says `CAP_NET_BIND_SERVICE`. Same capability, one spelling here, so
# the comparison below is about WHICH capabilities ran and never about the
# engine that echoed them.
obsync_hardening="${obsync_hardening//CAP_/}"
case "${obsync_hardening}" in
  'readonly=true capdrop=[ALL] capadd=[] secopt=[no-new-privileges:true] user=65532:65532') ;;
  *) deny "the obsync container did not run hardened: ${obsync_hardening}" ;;
esac
caddy_hardening="$(docker container inspect --format \
  'readonly={{.HostConfig.ReadonlyRootfs}} capdrop={{.HostConfig.CapDrop}} capadd={{.HostConfig.CapAdd}} secopt={{.HostConfig.SecurityOpt}}' \
  "${caddy_container}")"
caddy_hardening="${caddy_hardening//CAP_/}"
case "${caddy_hardening}" in
  'readonly=true capdrop=[ALL] capadd=[NET_BIND_SERVICE] secopt=[no-new-privileges:true]') ;;
  *) deny "the caddy container did not run hardened: ${caddy_hardening}" ;;
esac
prove "hardening: obsync ran ${obsync_hardening}; caddy ran ${caddy_hardening}"

printf 'compose-smoke: SUMMARY image=%s terminator=%s steps=%d duration=%ds decision=pass\n' \
  "${image}" "${caddy_image}" "${proven}" "$(( $(date +%s) - started_at ))"
