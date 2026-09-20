#!/usr/bin/env bash
# helm-e2e -- install THIS repository's chart into a throwaway `kind` cluster,
# with the storage and the values docs/kubernetes.md SHOWS, and prove the pod
# serves.
#
# WHY THIS EXISTS. `helm lint`, `helm template` and `scripts/ci/chart_pins.py`
# prove what the chart RENDERS. Nothing proved that the rendered objects reach
# a running server, and the reference activation is where that difference
# lives: a claim that stays `Pending` because its class binds on first
# consumer, a volume the runtime uid cannot write, a digest nothing can
# resolve, a readiness probe that reports the proxy in front of the app. Every
# one of those renders perfectly.
#
# And the STORAGE and the VALUES are read out of docs/kubernetes.md at this
# commit by scripts/ci/docs_blocks.py, not copied here, for the reason
# scripts/ci/compose-e2e.sh gives: a guide is a set of commands a stranger
# pastes, and the only way its text can be trusted is for CI to run THAT text.
#
# WHAT IT PROVES, in the order the reference activation met them:
#
#   1. preflight    kind at the pinned version, helm, kubectl, docker, the
#                   chart, the image this run was given (which must be the
#                   repository:tag the chart's own values name, because the
#                   values schema fixes the repository and the release
#                   contract fixes the tag), and no cluster of this name.
#   2. a cluster    one node, from the node image pinned beside kind, with a
#                   kubeconfig of its own in this run's scratch directory so
#                   nothing touches the caller's.
#   3. the page's   the `<!-- ci: k8s-volume-dirs -->` block prepares the two
#      directories  directories ON THE NODE, `0700` and owned by 65532. This
#                   is the rule the server enforces and the one a first
#                   deployment gets wrong; `sudo` is dropped because the
#                   command already runs as the node's root.
#   4. the page's   the `<!-- ci: k8s-storage -->` block creates the class and
#      volumes      the two `local` PersistentVolumes, with this cluster's
#                   node name and sizes a runner can hold.
#   5. by digest    the image is loaded into the cluster and containerd is
#                   ASKED what digest it stored. That digest is what the chart
#                   deploys, so the pod reference is `repository:tag@sha256:…`
#                   exactly as a published install is -- a tag would have made
#                   this test prove something the reference deployment never
#                   does.
#   6. the page's   the `<!-- ci: k8s-values -->` block installs the chart
#      values       from this repository, with the server-key Secret from
#                   chart/README.md section 1 and nothing else supplied.
#   7. claims bind  both PersistentVolumeClaims reach `Bound`. With
#                   `WaitForFirstConsumer` that cannot happen until a pod is
#                   scheduled, so this is also the proof that `deploymentReady`
#                   did what section 3 says it does.
#   8. it serves    the Deployment goes `Available` and `/readyz` answers
#                   `{"ready":true` through a port-forward -- the server's own
#                   answer, from the volumes prepared in step 3.
#   9. a TLS front  the `<!-- ci: k8s-tls-front -->` block is applied with a
#                   leaf this job issues, and `/readyz` is answered THROUGH it
#                   over HTTPS. Requirement 7 says the server never terminates
#                   TLS, so the deployment a reader ends up with is this one,
#                   not the port-forward above.
#  10. it syncs      the `<!-- ci: k8s-token -->` block reads the setup token
#                   off the node, and `scripts/ci/api_flow.py` enrols the
#                   account with it through the terminator, pairs a second
#                   device, pushes one file larger than a stock proxy's body
#                   ceiling, reads it back on the other device, and is refused
#                   by name for a missing, altered, stale and replayed
#                   signature.
#  11. upgrade and  `helm upgrade` re-deploys by the same digest with one
#      rollback     value changed, `helm rollback` returns the release, and the
#                   account, both devices and the file are still there after
#                   two pod replacements -- which is what section 8 of the page
#                   promises an operator.
#  12. teardown     the cluster is deleted. It runs from a trap, so a failure
#                   at any step above deletes it too: a kind cluster left
#                   behind holds a container, a network and a volume on the
#                   runner.
#
# WHAT IT DOES NOT PROVE, stated rather than implied: the NetworkPolicy's
# refusals (kind's CNI does not enforce policy, so they are proven against the
# RENDERED policy by scripts/ci/chart_pins.py), the DNS-01 certificate ceremony
# (the leaf here is issued by the job, and what is proven is the terminator and
# the wiring, never the issuance), and the private route.
# docs/kubernetes.md section 9 says the same thing to a reader.
#
# Requires: kind, helm, kubectl, docker, curl, openssl, python3.
set -euo pipefail

usage() {
  printf 'usage: %s <obsync-image-reference>\n' "${0##*/}" >&2
  printf '  Installs chart/ into a throwaway kind cluster with that image.\n' >&2
}

if [ "$#" -ne 1 ] || [ -z "${1:-}" ]; then
  usage
  exit 2
fi
image="$1"

here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "${here}/../.." && pwd)"
readonly GUIDE='docs/kubernetes.md'
readonly CLUSTER='obsync-e2e'
readonly NODE='obsync-e2e-control-plane'
readonly NAMESPACE='obsidian'
readonly RELEASE='obsync'
# The sizes are NOT substituted, and that is a decision rather than an
# omission. A `local` volume reserves nothing, and the server computes free
# space as declared capacity minus tracked usage rather than from the
# filesystem (docs/storage.md, "Free-space watermark and quota"), so the page's
# own 250Gi and 4Gi run here exactly as a reader pastes them. Shrinking them to
# "sizes a runner can hold" is what would break: the watermark is the LARGER of
# 5 % and 2 GiB, so a journal claim under 2 GiB is full before the first write
# and every request is refused `507 journal_full`.
readonly FORWARD_PORT=18081
# The terminator of docs/kubernetes.md section 4, and the leaf this job issues
# for it. `.invalid` is reserved by RFC 2606 and can never resolve, so the
# certificate is demonstrably the only reason the name verifies.
readonly INGRESS_NAMESPACE='obsync-ingress'
readonly FRONT='tls-front'
readonly FRONT_HOST='sync-e2e.invalid'
readonly FRONT_PORT=18443
# The digest this run pulls the terminator at. The page shows the TAG, as a
# reader reads it, and tells them to pin their own; the substitution below is
# what names the bytes this job may run, and the tag it replaces is checked
# against the page by scripts/ci/test_selfhosting_contract.py.
readonly FRONT_IMAGE='docker.io/library/nginx:1.29-alpine@sha256:5616878291a2eed594aee8db4dade5878cf7edcb475e59193904b198d9b830de'
# Requirement 12: every wait names the budget it is measured against.
readonly CLUSTER_BUDGET_SECONDS=300
readonly BIND_BUDGET_SECONDS=180
readonly AVAILABLE_BUDGET_SECONDS=180
readonly READY_BUDGET_SECONDS=60

# The kind pin is ONE fact and lives in scripts/ci/install-kind.sh; this reads
# it rather than restating it, so a bumped pin cannot leave this file behind.
kind_version="$(awk -F= '/^KIND_VERSION=/{print $2}' "${here}/install-kind.sh")"
node_image="$(awk -F= '/^KIND_NODE_IMAGE=/{print $2}' "${here}/install-kind.sh")"

scratch="$(mktemp -d "${TMPDIR:-/tmp}/helm-e2e.XXXXXX")"
export KUBECONFIG="${scratch}/kubeconfig"
forward_pid=''
front_pid=''
started_at="$(date +%s)"
step_at="${started_at}"

proven=0
prove() {
  local now
  now="$(date +%s)"
  proven=$((proven + 1))
  printf 'helm-e2e: (%d) %s [%ds]\n' "${proven}" "$1" "$((now - step_at))"
  step_at="${now}"
}

deny() {
  printf 'helm-e2e: DENY %s\n' "$1" >&2
  # The refusal is worth nothing without the cluster's own account of it, and
  # the trap is about to delete the cluster.
  if kubectl cluster-info >/dev/null 2>&1; then
    printf 'helm-e2e: --- objects ---\n' >&2
    kubectl get pods,pvc,pv --namespace "${NAMESPACE}" >&2 2>&1 || true
    printf 'helm-e2e: --- pod events ---\n' >&2
    kubectl describe pods --namespace "${NAMESPACE}" >&2 2>&1 | tail -n 40 || true
    printf 'helm-e2e: --- server log ---\n' >&2
    kubectl logs --namespace "${NAMESPACE}" "deploy/${RELEASE}" --tail 40 >&2 2>&1 || true
    if kubectl get namespace "${INGRESS_NAMESPACE}" >/dev/null 2>&1; then
      printf 'helm-e2e: --- terminator ---\n' >&2
      kubectl get pods --namespace "${INGRESS_NAMESPACE}" >&2 2>&1 || true
      kubectl logs --namespace "${INGRESS_NAMESPACE}" "deploy/${FRONT}" --tail 40 >&2 2>&1 || true
    fi
  fi
  exit 1
}

cleanup() {
  local status=$?
  for pid in "${forward_pid}" "${front_pid}"; do
    if [ -n "${pid}" ]; then
      kill "${pid}" >/dev/null 2>&1 || true
      wait "${pid}" 2>/dev/null || true
    fi
  done
  kind delete cluster --name "${CLUSTER}" >/dev/null 2>&1 || true
  rm -rf -- "${scratch}"
  return "${status}"
}
trap cleanup EXIT

# The documented text, with this run's values substituted by name. It is the
# ONE place any documented manifest or command enters this script.
documented() {
  python3 -B "${here}/docs_blocks.py" "${GUIDE}" "$@"
}

printf 'helm-e2e: START image=%s guide=%s cluster=%s kind=%s node_image=%s\n' \
  "${image}" "${GUIDE}" "${CLUSTER}" "${kind_version}" "${node_image}"

# (1) Preflight.
for tool in kind helm kubectl docker curl openssl python3; do
  command -v "${tool}" >/dev/null 2>&1 || deny "${tool} is not installed; this script installs nothing"
done
installed="v$(kind version --quiet)"
[ "${installed}" = "${kind_version}" ] \
  || deny "kind ${installed} is installed but this repository pins ${kind_version} (scripts/ci/install-kind.sh)"
[ -f "${root}/chart/Chart.yaml" ] || deny "no chart at ${root}/chart"
version="$(tr -d '[:space:]' < "${root}/VERSION")"
expected_image="ghcr.io/snaraj/obsync:v${version}"
[ "${image}" = "${expected_image}" ] \
  || deny "this run was given ${image}, but the chart's values fix the repository (values.schema.json) and the release contract fixes the tag, so the only image it can deploy is ${expected_image}"
docker image inspect "${image}" >/dev/null 2>&1 \
  || deny "no local image ${image}; this script builds nothing"
if kind get clusters 2>/dev/null | grep -qx "${CLUSTER}"; then
  deny "a kind cluster called ${CLUSTER} already exists; this run would delete somebody else's"
fi
prove "preflight: kind ${installed}, helm, kubectl, ${image}, no ${CLUSTER} cluster"

# (2) One node, its own kubeconfig.
kind create cluster --name "${CLUSTER}" --image "${node_image}" \
  --kubeconfig "${KUBECONFIG}" --wait "${CLUSTER_BUDGET_SECONDS}s" \
  || deny "kind could not create ${CLUSTER} within ${CLUSTER_BUDGET_SECONDS}s"
kubectl get node "${NODE}" >/dev/null 2>&1 \
  || deny "the cluster has no node called ${NODE}; the documented volumes name it"
prove "cluster: ${CLUSTER} is up on ${node_image} with a kubeconfig in this run's scratch directory"

# (3) The page's directory preparation, run on the node. `sudo` is dropped
# because `docker exec` is already root there, and that is the ONE difference
# between what the page shows and what this runs.
directories="$(documented k8s-volume-dirs --substitute 'sudo =')" \
  || deny "${GUIDE} no longer shows the volume-directory block this gate substitutes into"
printf 'helm-e2e: running on %s, from %s:\n%s\n' "${NODE}" "${GUIDE}" "${directories}"
docker exec "${NODE}" sh -c "${directories}" \
  || deny 'the documented volume-directory preparation failed on the node'
ownership="$(docker exec "${NODE}" stat -c '%a %u:%g' /var/lib/obsync/blobs /var/lib/obsync/journal | sort -u)"
[ "${ownership}" = '700 65532:65532' ] \
  || deny "the documented preparation left ${ownership}, not 700 65532:65532"
prove "the page's directories: both are ${ownership} on ${NODE}"

# (4) The page's class and volumes.
storage="$(documented k8s-storage --substitute "sync-node=${NODE}")" \
  || deny "${GUIDE} no longer shows the storage block this gate substitutes into"
printf 'helm-e2e: applying, from %s:\n%s\n' "${GUIDE}" "${storage}"
printf '%s\n' "${storage}" | kubectl apply -f - \
  || deny 'the documented StorageClass and PersistentVolumes were refused by the API server'
prove "the page's volumes: the documented StorageClass and both PersistentVolumes exist"

# (5) The image, and the digest containerd actually holds.
kind load docker-image "${image}" --name "${CLUSTER}" >/dev/null \
  || deny "kind could not load ${image} into ${CLUSTER}"
digest="$(docker exec "${NODE}" ctr --namespace k8s.io images ls \
  "name==${image}" | awk 'NR == 2 {print $3}')"
case "${digest}" in
  sha256:*) ;;
  *) deny "containerd holds no manifest digest for ${image}: ${digest:-nothing}" ;;
esac
# A loaded image is known by its TAG alone, and a pod reference carrying a
# digest is resolved in canonical digest form -- so without this the kubelet
# refuses `ErrImageNeverPull` for bytes that are sitting on the node. Naming
# the same manifest in digest form is what a registry pull would have left
# behind, and it is why `pullPolicy: Never` is the honest policy here: the
# deployment can only ever run these bytes, never something a pull fetched.
repository="${image%%:*}"
docker exec "${NODE}" ctr --namespace k8s.io images tag \
  "${image}" "${repository}@${digest}" >/dev/null \
  || deny "containerd would not name ${image} as ${repository}@${digest}"
prove "by digest: containerd holds ${image} as ${digest}, named in digest form for the kubelet"

# (6) The page's values, plus the Secret ceremony chart/README.md section 1
# documents. The key is generated here, written with no trailing newline, and
# handed over as a FILE: an argument would put a credential in this node's
# process table.
values="$(documented k8s-values)" \
  || deny "${GUIDE} no longer shows the values block this gate substitutes into"
printf 'helm-e2e: installing, from %s:\n%s\n' "${GUIDE}" "${values}"
printf '%s\n' "${values}" > "${scratch}/values.yaml"
kubectl create namespace "${NAMESPACE}" >/dev/null \
  || deny "could not create namespace ${NAMESPACE}"
umask 077
openssl rand -hex 32 | tr -d '\n' > "${scratch}/server-key"
kubectl create secret generic obsync-server-key --namespace "${NAMESPACE}" \
  --from-file="OBSYNC_SERVER_KEY=${scratch}/server-key" >/dev/null \
  || deny 'could not create the obsync-server-key Secret'
helm install "${RELEASE}" "${root}/chart" \
  --namespace "${NAMESPACE}" \
  --values "${scratch}/values.yaml" \
  --set "image.digest=${digest}" \
  --set image.pullPolicy=Never \
  || deny 'helm install refused the documented values'
prove "the page's values: ${RELEASE} installed from ${root}/chart into ${NAMESPACE}"

# (7) Both claims bind. `WaitForFirstConsumer` means this cannot happen before
# a pod is scheduled, so a claim stuck here is `deploymentReady` or the node
# affinity, and the refusal says which by printing both objects.
for claim in obsync-blobs obsync-journal; do
  kubectl wait "pvc/${claim}" --namespace "${NAMESPACE}" \
    --for=jsonpath='{.status.phase}'=Bound \
    --timeout="${BIND_BUDGET_SECONDS}s" >/dev/null \
    || deny "pvc/${claim} did not bind within ${BIND_BUDGET_SECONDS}s"
done
prove "claims bind: obsync-blobs and obsync-journal are Bound to the documented volumes"

# (8) It serves, and it is the digest that is running.
kubectl wait "deploy/${RELEASE}" --namespace "${NAMESPACE}" \
  --for=condition=Available --timeout="${AVAILABLE_BUDGET_SECONDS}s" >/dev/null \
  || deny "deploy/${RELEASE} was not Available within ${AVAILABLE_BUDGET_SECONDS}s"
running="$(kubectl get pods --namespace "${NAMESPACE}" \
  --selector app.kubernetes.io/name=obsync \
  --output jsonpath='{.items[0].spec.containers[0].image}')"
[ "${running}" = "${image}@${digest}" ] \
  || deny "the pod runs ${running}, not ${image}@${digest}: this deployment is not by digest"
kubectl port-forward --namespace "${NAMESPACE}" "service/${RELEASE}" \
  "${FORWARD_PORT}:8080" >"${scratch}/forward.log" 2>&1 &
forward_pid=$!
ready=''
for _ in $(seq 1 "${READY_BUDGET_SECONDS}"); do
  kill -0 "${forward_pid}" 2>/dev/null \
    || deny "the port-forward exited: $(cat "${scratch}/forward.log")"
  body="$(curl --silent --show-error --max-time 3 \
    "http://127.0.0.1:${FORWARD_PORT}/readyz" 2>/dev/null || true)"
  case "${body}" in
    '{"ready":true'*)
      ready="${body}"
      break
      ;;
  esac
  sleep 1
done
[ -n "${ready}" ] \
  || deny "no {\"ready\":true from /readyz through the port-forward within ${READY_BUDGET_SECONDS}s"
prove "it serves: ${running} answered ${ready} on /readyz through a port-forward"

# The service port-forward has said what it can say: the app answers its own
# probe. Everything below goes through the terminator instead, which is the
# path a device actually takes.
kill "${forward_pid}" >/dev/null 2>&1 || true
wait "${forward_pid}" 2>/dev/null || true
forward_pid=''

# (9) A TLS front, from the page's own manifest. The leaf is issued here and
# is NOT the ceremony of section 4: what this proves is the terminator, the
# three peer labels and the wiring, never the issuance.
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes \
  -keyout "${scratch}/tls.key" -out "${scratch}/tls.crt" -days 1 \
  -subj "/CN=${FRONT_HOST}" -addext "subjectAltName=DNS:${FRONT_HOST}" >/dev/null 2>&1 \
  || deny 'openssl could not issue the leaf this run terminates with'
front="$(documented k8s-tls-front --substitute "nginx:1.29-alpine=${FRONT_IMAGE}")" \
  || deny "${GUIDE} no longer shows the TLS-front block this gate substitutes into"
printf 'helm-e2e: applying, from %s:\n%s\n' "${GUIDE}" "${front}"
printf '%s\n' "${front}" | kubectl apply -f - \
  || deny 'the documented TLS front was refused by the API server'
kubectl create secret tls obsync-tls --namespace "${INGRESS_NAMESPACE}" \
  --cert "${scratch}/tls.crt" --key "${scratch}/tls.key" >/dev/null \
  || deny 'could not install the leaf as the obsync-tls Secret the documented front mounts'
kubectl wait "deploy/${FRONT}" --namespace "${INGRESS_NAMESPACE}" \
  --for=condition=Available --timeout="${AVAILABLE_BUDGET_SECONDS}s" >/dev/null \
  || deny "the documented TLS front was not Available within ${AVAILABLE_BUDGET_SECONDS}s"
kubectl port-forward --namespace "${INGRESS_NAMESPACE}" "service/${FRONT}" \
  "${FRONT_PORT}:443" >"${scratch}/front.log" 2>&1 &
front_pid=$!
ready=''
for _ in $(seq 1 "${READY_BUDGET_SECONDS}"); do
  kill -0 "${front_pid}" 2>/dev/null \
    || deny "the terminator port-forward exited: $(cat "${scratch}/front.log")"
  body="$(curl --silent --show-error --max-time 3 \
    --cacert "${scratch}/tls.crt" \
    --resolve "${FRONT_HOST}:${FRONT_PORT}:127.0.0.1" \
    "https://${FRONT_HOST}:${FRONT_PORT}/readyz" 2>/dev/null || true)"
  case "${body}" in
    '{"ready":true'*)
      ready="${body}"
      break
      ;;
  esac
  sleep 1
done
[ -n "${ready}" ] \
  || deny "no {\"ready\":true through the documented TLS front within ${READY_BUDGET_SECONDS}s"
prove "a TLS front: the documented terminator answered ${ready} over HTTPS, on a certificate this run issued"

# (10) The page's token read, and the whole sync flow through the terminator.
# The token is masked in the runner's log before it is used and is printed by
# nothing: not this script, not the client, not a refusal.
token_command="$(documented k8s-token --substitute 'sudo =')" \
  || deny "${GUIDE} no longer shows the token-read block this gate substitutes into"
printf 'helm-e2e: running on %s, from %s:\n%s\n' "${NODE}" "${GUIDE}" "${token_command}"
token="$(docker exec "${NODE}" sh -c "${token_command}" | tr -d '[:space:]')" \
  || deny 'the documented token read found nothing on the node'
if [ -n "${GITHUB_ACTIONS:-}" ]; then
  printf '::add-mask::%s\n' "${token}"
fi
printf '%s' "${token}" | grep -Eq '^[0-9a-f]{64}$' \
  || deny "the token the documented command read is not 64 lowercase hex characters (${#token} characters read)"
printf '%s' "${token}" | python3 -B "${here}/api_flow.py" enroll \
  --host "${FRONT_HOST}" --port "${FRONT_PORT}" --address 127.0.0.1 \
  --cacert "${scratch}/tls.crt" --state "${scratch}/devices.json" \
  || deny 'the documented deployment could not carry the sync flow through its terminator'
prove "the page's token read: ${#token} hex characters off the node, and the flow it unlocks ran through the terminator"

# (11) Upgrade and roll back, both on the digest, with the data outliving two
# pod replacements. Section 8 of the page promises exactly this, and a claim
# about a rollback is worth nothing until something has been rolled back.
helm upgrade "${RELEASE}" "${root}/chart" \
  --namespace "${NAMESPACE}" \
  --values "${scratch}/values.yaml" \
  --set "image.digest=${digest}" \
  --set image.pullPolicy=Never \
  --set retention.days=14 \
  --wait --timeout "${AVAILABLE_BUDGET_SECONDS}s" >/dev/null \
  || deny 'helm upgrade refused the documented values'
upgraded="$(helm get values "${RELEASE}" --namespace "${NAMESPACE}" --output json)"
case "${upgraded}" in
  *'"days":14'*) ;;
  *) deny "the upgrade did not take: helm holds ${upgraded}" ;;
esac
running="$(kubectl get pods --namespace "${NAMESPACE}" \
  --selector app.kubernetes.io/name=obsync \
  --output jsonpath='{.items[0].spec.containers[0].image}')"
[ "${running}" = "${image}@${digest}" ] \
  || deny "after the upgrade the pod runs ${running}, not ${image}@${digest}"
helm rollback "${RELEASE}" 1 --namespace "${NAMESPACE}" \
  --wait --timeout "${AVAILABLE_BUDGET_SECONDS}s" >/dev/null \
  || deny 'helm rollback refused'
rolled="$(helm get values "${RELEASE}" --namespace "${NAMESPACE}" --output json)"
case "${rolled}" in
  *'"days":14'*) deny "the rollback left the upgrade's value behind: ${rolled}" ;;
esac
running="$(kubectl get pods --namespace "${NAMESPACE}" \
  --selector app.kubernetes.io/name=obsync \
  --output jsonpath='{.items[0].spec.containers[0].image}')"
[ "${running}" = "${image}@${digest}" ] \
  || deny "after the rollback the pod runs ${running}, not ${image}@${digest}"
python3 -B "${here}/api_flow.py" verify \
  --host "${FRONT_HOST}" --port "${FRONT_PORT}" --address 127.0.0.1 \
  --cacert "${scratch}/tls.crt" --state "${scratch}/devices.json" \
  || deny 'the upgraded and rolled-back release lost the account, the devices or the data'
prove "upgrade and rollback: two pod replacements on ${digest}, and the account, both devices and the file came through both"

# (12) Teardown, proven rather than assumed. The trap runs it again and finds
# nothing, which is what an always-run cleanup is for.
kill "${forward_pid}" >/dev/null 2>&1 || true
wait "${forward_pid}" 2>/dev/null || true
forward_pid=''
kind delete cluster --name "${CLUSTER}" >/dev/null 2>&1 \
  || deny "could not delete cluster ${CLUSTER}"
if kind get clusters 2>/dev/null | grep -qx "${CLUSTER}"; then
  deny "cluster ${CLUSTER} survived deletion"
fi
prove "teardown: cluster ${CLUSTER} is gone"

printf 'helm-e2e: SUMMARY image=%s guide=%s cluster=%s steps=%d duration=%ds decision=pass\n' \
  "${image}" "${GUIDE}" "${CLUSTER}" "${proven}" "$(( $(date +%s) - started_at ))"
