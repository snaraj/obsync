#!/usr/bin/env bash
# k3d-e2e -- the chart on k3s as k3s ships: its own Traefik as the ingress, its
# own local-path provisioner for the volumes, its own network-policy
# controller enforcing the chart's policy.
#
# WHY THIS EXISTS, BESIDE helm-e2e.sh. helm-e2e runs the Kubernetes guide as
# written: static `local` volumes a reader prepares and an nginx front a reader
# deploys. Most homelab clusters are not built that way. k3s -- the common
# single-node choice -- hands a claim a directory the local-path provisioner
# makes world-writable, which the server refuses by design (docs/storage.md,
# "Volume posture"), and fronts everything with Traefik in kube-system. This
# run proves that path end to end, including the refusal and the one
# administrator step docs/server.md ("Volume ownership") gives for it: chown
# the backing directory to 65532 and close it to 0700, once, on the node.
#
# WHAT IT PROVES, in order:
#   1. preflight    k3d at the pinned version, the pinned k3s image, helm,
#                   kubectl, docker, the chart's own image name.
#   2. a cluster    one k3s server from the digest-pinned image, no k3d load
#                   balancer, 443 published on loopback only.
#   3. k3s itself   Traefik and local-path are Available, and the peer labels
#                   the chart is given are READ off the running Traefik.
#   4. by digest    the image imported into k3s's containerd, deployed by the
#                   digest it holds, `pullPolicy: Never`.
#   5. the refusal  the claims bind to local-path directories and the server
#                   REFUSES them, visibly, before anyone fixes anything.
#   6. the chown    the documented administrator step on the node, then the
#                   pod serves.
#   7. Traefik      an Ingress with a job-issued leaf; `/readyz` through it.
#   8. it syncs     `api_flow.py enroll` through Traefik.
#   9. the policy   `np-probe.sh` against k3s's enforcing controller.
#  10. it persists  the pod is replaced and `api_flow.py verify` finds both
#                   devices, the file, and the spent nonce.
#  11. teardown     the cluster is deleted, from a trap as well.
#
# Requires: k3d, helm, kubectl, docker, curl, openssl, python3.
set -euo pipefail

usage() {
  printf 'usage: %s <obsync-image-reference>\n' "${0##*/}" >&2
}
if [ "$#" -ne 1 ] || [ -z "${1:-}" ]; then
  usage
  exit 2
fi
image="$1"

here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "${here}/../.." && pwd)"
k3d_version="$(awk -F= '/^K3D_VERSION=/{print $2}' "${here}/install-k3d.sh")"
k3s_image="$(awk -F= '/^K3S_IMAGE=/{print $2}' "${here}/install-k3d.sh")"
# The probe pods' image: the digest docs/kubernetes.md pins for its TLS front,
# which helm-e2e.sh already runs.
probe_image="$(awk '$1 == "image:" && $2 ~ /^docker\.io\/library\/nginx:.*@sha256:/ {print $2; exit}' "${root}/docs/kubernetes.md")"

run_id="$(printf '%s' "${OBSYNC_E2E_RUN_ID:-$$-${RANDOM}}" | tr -c '[:alnum:]_-' '-')"
readonly CLUSTER="obsync-e2e-${run_id}"
readonly NODE="k3d-${CLUSTER}-server-0"
readonly NAMESPACE='obsidian'
readonly RELEASE='obsync'
readonly HOST='sync-k3d.invalid'
readonly HTTPS_PORT=18877
readonly CLUSTER_BUDGET_SECONDS=300
readonly WAIT_BUDGET_SECONDS=180

scratch="$(mktemp -d "${TMPDIR:-/tmp}/k3d-e2e.XXXXXX")"
export KUBECONFIG="${scratch}/kubeconfig"
created=''
started_at="$(date +%s)"
step_at="${started_at}"

proven=0
prove() {
  local now
  now="$(date +%s)"
  proven=$((proven + 1))
  printf 'k3d-e2e: (%d) %s [%ds]\n' "${proven}" "$1" "$((now - step_at))"
  step_at="${now}"
}

deny() {
  printf 'k3d-e2e: DENY %s\n' "$1" >&2
  if [ -n "${created}" ] && kubectl cluster-info >/dev/null 2>&1; then
    kubectl get pods,pvc,pv --all-namespaces >&2 2>&1 || true
    kubectl logs --namespace "${NAMESPACE}" "deploy/${RELEASE}" --tail 40 >&2 2>&1 || true
  fi
  exit 1
}

cleanup() {
  local status=$?
  if [ -n "${created}" ]; then
    k3d cluster delete "${CLUSTER}" >/dev/null 2>&1 || true
  fi
  rm -rf -- "${scratch}"
  return "${status}"
}

# Wait until a command succeeds, within a budget that is named in the refusal.
until_ok() {
  local what="$1"
  shift
  for _ in $(seq 1 "${WAIT_BUDGET_SECONDS}"); do
    if "$@" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  deny "${what} within ${WAIT_BUDGET_SECONDS}s"
}

printf 'k3d-e2e: START image=%s cluster=%s k3d=%s k3s_image=%s\n' "${image}" "${CLUSTER}" "${k3d_version}" "${k3s_image}"

# (1) Preflight.
for tool in k3d helm kubectl docker curl openssl python3; do
  command -v "${tool}" >/dev/null 2>&1 || deny "${tool} is not installed; this script installs nothing"
done
k3d version | grep -qx "k3d version ${k3d_version}" \
  || deny "k3d $(k3d version | head -n 1) is installed but this repository pins ${k3d_version} (scripts/ci/install-k3d.sh)"
version="$(tr -d '[:space:]' < "${root}/VERSION")"
[ "${image}" = "ghcr.io/snaraj/obsync:v${version}" ] \
  || deny "the chart deploys ghcr.io/snaraj/obsync:v${version} (values.schema.json), not ${image}"
docker image inspect "${image}" >/dev/null 2>&1 || deny "no local image ${image}; this script builds nothing"
[ -n "${probe_image}" ] || deny 'docs/kubernetes.md pins no nginx image by digest for the probe pods'
! k3d cluster get "${CLUSTER}" >/dev/null 2>&1 || deny "a k3d cluster called ${CLUSTER} already exists"
python3 -c 'import socket,sys; s=socket.socket(); s.bind(("127.0.0.1", int(sys.argv[1]))); s.close()' "${HTTPS_PORT}" 2>/dev/null \
  || deny "127.0.0.1:${HTTPS_PORT} is taken"
prove "preflight: k3d ${k3d_version}, helm, kubectl, ${image}, no ${CLUSTER} cluster, port ${HTTPS_PORT} free"

trap cleanup EXIT

# (2) One k3s server. No k3d load balancer: 443 is published straight off the
# node, where k3s's own service load balancer hands it to Traefik.
created='cluster'
k3d cluster create "${CLUSTER}" --image "${k3s_image}" --no-lb \
  --port "127.0.0.1:${HTTPS_PORT}:443@server:0:direct" \
  --kubeconfig-update-default=false --kubeconfig-switch-context=false \
  --wait --timeout "${CLUSTER_BUDGET_SECONDS}s" >"${scratch}/create.log" 2>&1 \
  || { cat "${scratch}/create.log" >&2; deny "k3d could not create ${CLUSTER}"; }
k3d kubeconfig get "${CLUSTER}" > "${KUBECONFIG}" || deny 'k3d gave no kubeconfig'
prove "a cluster: ${CLUSTER} on ${k3s_image}, 443 on 127.0.0.1:${HTTPS_PORT}"

# (3) k3s's own components, and the peer identity read off Traefik itself.
until_ok 'Traefik was not deployed' kubectl --namespace kube-system get deploy/traefik
kubectl --namespace kube-system wait deploy/traefik deploy/local-path-provisioner \
  --for=condition=Available --timeout "${WAIT_BUDGET_SECONDS}s" >/dev/null \
  || deny "Traefik and local-path were not Available within ${WAIT_BUDGET_SECONDS}s"
peer_app="$(kubectl --namespace kube-system get deploy/traefik \
  --output jsonpath='{.spec.template.metadata.labels.app\.kubernetes\.io/name}')"
peer_instance="$(kubectl --namespace kube-system get deploy/traefik \
  --output jsonpath='{.spec.template.metadata.labels.app\.kubernetes\.io/instance}')"
[ -n "${peer_app}" ] && [ -n "${peer_instance}" ] || deny "Traefik's pods carry no name and instance labels to admit"
prove "k3s itself: Traefik (${peer_app}/${peer_instance}) and local-path are Available"

# (4) The image, by the digest k3s's containerd holds.
docker save "${image}" | docker exec --interactive "${NODE}" ctr --namespace k8s.io images import - >/dev/null \
  || deny "could not import ${image} into ${NODE}"
digest="$(docker exec "${NODE}" ctr --namespace k8s.io images ls "name==${image}" | awk 'NR == 2 {print $3}')"
case "${digest}" in sha256:*) ;; *) deny "containerd holds no digest for ${image}" ;; esac
docker exec "${NODE}" ctr --namespace k8s.io images tag "${image}" "${image%%:*}@${digest}" >/dev/null \
  || deny "containerd would not name ${image} in digest form"
prove "by digest: ${image} is ${digest} in k3s's containerd"

# (5) The chart on local-path. The server must refuse the directories the
# provisioner makes, BEFORE anything is fixed: a run that never saw the refusal
# would not know the step below is the one that fixed it.
cat > "${scratch}/values.yaml" <<VALUES
deploymentReady: true
storage:
  blobs:
    className: local-path
    size: 250Gi
    capacity: 250Gi
  journal:
    className: local-path
    size: 4Gi
    capacity: 4Gi
  mirrors: []
ingress:
  peers:
    - namespace: kube-system
      appName: ${peer_app}
      instance: ${peer_instance}
publicUrl: "https://${HOST}:${HTTPS_PORT}"
VALUES
kubectl create namespace "${NAMESPACE}" >/dev/null
umask 077
openssl rand -hex 32 | tr -d '\n' > "${scratch}/server-key"
umask 022
kubectl create secret generic obsync-server-key --namespace "${NAMESPACE}" \
  --from-file="OBSYNC_SERVER_KEY=${scratch}/server-key" >/dev/null || deny 'could not create the server-key Secret'
helm install "${RELEASE}" "${root}/chart" --namespace "${NAMESPACE}" --values "${scratch}/values.yaml" \
  --set "image.digest=${digest}" --set image.pullPolicy=Never >/dev/null || deny 'helm install refused'
for claim in obsync-blobs obsync-journal; do
  kubectl wait "pvc/${claim}" --namespace "${NAMESPACE}" --for=jsonpath='{.status.phase}'=Bound \
    --timeout "${WAIT_BUDGET_SECONDS}s" >/dev/null || deny "pvc/${claim} did not bind to a local-path volume"
done
refusal=''
for _ in $(seq 1 "${WAIT_BUDGET_SECONDS}"); do
  # The refusing container exits, so its line is in the current log or, once
  # it has been restarted, the previous one.
  refusal="$( { kubectl logs --namespace "${NAMESPACE}" "deploy/${RELEASE}" --tail 50 2>/dev/null
    kubectl logs --namespace "${NAMESPACE}" "deploy/${RELEASE}" --previous --tail 50 2>/dev/null; } \
    | grep -m 1 'event=posture.*decision=refused' || true)"
  [ -n "${refusal}" ] && break
  sleep 1
done
[ -n "${refusal}" ] || deny 'the server did not refuse the local-path directories; the posture check this run relies on is not being exercised'
prove "the refusal: the server refused local-path's directories as provisioned: ${refusal}"

# (6) The documented administrator step, on the node, for each claim's
# backing directory, then a fresh pod.
for claim in obsync-blobs obsync-journal; do
  volume="$(kubectl get "pvc/${claim}" --namespace "${NAMESPACE}" --output jsonpath='{.spec.volumeName}')"
  path="$(kubectl get "pv/${volume}" --output jsonpath='{.spec.hostPath.path}{.spec.local.path}')"
  [ -n "${path}" ] || deny "pv/${volume} names no directory on the node"
  docker exec "${NODE}" sh -c "chown 65532:65532 '${path}' && chmod 0700 '${path}'" \
    || deny "could not prepare ${path} on ${NODE}"
done
kubectl delete pod --namespace "${NAMESPACE}" --selector app.kubernetes.io/name=obsync --wait=false >/dev/null
kubectl wait "deploy/${RELEASE}" --namespace "${NAMESPACE}" --for=condition=Available \
  --timeout "${WAIT_BUDGET_SECONDS}s" >/dev/null || deny 'the server did not serve after the documented chown'
prove "the chown: both local-path directories 65532:65532 0700 on the node, and the server is Available"

# (7) Traefik in front, with a leaf this run issues.
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -days 1 \
  -keyout "${scratch}/tls.key" -out "${scratch}/tls.crt" -subj "/CN=${HOST}" \
  -addext "subjectAltName=DNS:${HOST}" >/dev/null 2>&1 || deny 'openssl could not issue the leaf'
kubectl create secret tls obsync-tls --namespace "${NAMESPACE}" \
  --cert "${scratch}/tls.crt" --key "${scratch}/tls.key" >/dev/null || deny 'could not store the leaf'
kubectl apply --filename - >/dev/null <<INGRESS || deny 'the Ingress was refused'
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: ${RELEASE}
  namespace: ${NAMESPACE}
spec:
  ingressClassName: traefik
  tls:
    - hosts: [${HOST}]
      secretName: obsync-tls
  rules:
    - host: ${HOST}
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: ${RELEASE}
                port:
                  number: 8080
INGRESS
readyz() {
  curl --silent --fail --max-time 3 --cacert "${scratch}/tls.crt" \
    --resolve "${HOST}:${HTTPS_PORT}:127.0.0.1" "https://${HOST}:${HTTPS_PORT}/readyz" | grep -q '"ready":true'
}
until_ok 'no {"ready":true through Traefik' readyz
prove "Traefik: /readyz answers through k3s's own ingress over HTTPS"

# (8) The sync flow through Traefik.
umask 077
pod="$(kubectl get pods --namespace "${NAMESPACE}" --selector app.kubernetes.io/name=obsync \
  --output jsonpath='{.items[0].metadata.name}')"
volume="$(kubectl get pvc/obsync-journal --namespace "${NAMESPACE}" --output jsonpath='{.spec.volumeName}')"
journal="$(kubectl get "pv/${volume}" --output jsonpath='{.spec.hostPath.path}{.spec.local.path}')"
docker exec "${NODE}" cat "${journal}/v1/setup-token" | tr -d '[:space:]' > "${scratch}/token" \
  || deny "no setup token on the journal volume of ${pod}"
umask 022
if [ -n "${GITHUB_ACTIONS:-}" ]; then
  printf '::add-mask::%s\n' "$(cat "${scratch}/token")"
fi
python3 -B "${here}/api_flow.py" enroll --host "${HOST}" --port "${HTTPS_PORT}" --address 127.0.0.1 \
  --cacert "${scratch}/tls.crt" --state "${scratch}/devices.json" < "${scratch}/token" \
  || deny 'the sync flow failed through Traefik'
prove 'it syncs: first boot, pairing, one file each way and four refusals, through Traefik'

# (9) The policy, against k3s's enforcing controller.
"${here}/np-probe.sh" "http://${RELEASE}.${NAMESPACE}.svc.cluster.local:8080/livez" \
  kube-system "${peer_app}" "${peer_instance}" "${probe_image}" \
  || deny 'k3s does not enforce the NetworkPolicy the chart renders'
prove 'the policy holds: Traefik connects, a sibling instance and another namespace are refused'

# (10) A new pod on the same local-path volumes.
kubectl delete pod --namespace "${NAMESPACE}" --selector app.kubernetes.io/name=obsync --wait=true >/dev/null
kubectl wait "deploy/${RELEASE}" --namespace "${NAMESPACE}" --for=condition=Available \
  --timeout "${WAIT_BUDGET_SECONDS}s" >/dev/null || deny 'the replacement pod did not serve'
until_ok 'no {"ready":true after the replacement' readyz
python3 -B "${here}/api_flow.py" verify --host "${HOST}" --port "${HTTPS_PORT}" --address 127.0.0.1 \
  --cacert "${scratch}/tls.crt" --state "${scratch}/devices.json" \
  || deny 'the replacement pod lost the account, the devices or the data'
prove 'it persists: a replacement pod on the same volumes has both devices, the file and the spent nonce'

# (11) Teardown.
k3d cluster delete "${CLUSTER}" >/dev/null 2>&1 || deny "could not delete ${CLUSTER}"
created=''
prove "teardown: ${CLUSTER} is gone"
printf 'k3d-e2e: SUMMARY image=%s cluster=%s steps=%d duration=%ds decision=pass\n' \
  "${image}" "${CLUSTER}" "${proven}" "$(( $(date +%s) - started_at ))"
