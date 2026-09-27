#!/usr/bin/env bash
# np-probe -- ask the cluster's own network whether the chart's NetworkPolicy
# admits exactly the one peer it names, by opening connections from pods.
#
# WHY. `scripts/ci/chart_pins.py ingress` proves what the policy SAYS. Whether
# a cluster enforces it is a property of the CNI, and a policy the CNI ignores
# reads exactly as narrow as one it enforces. Three one-shot pods, identical
# but for where they stand and what they are labelled, try the same URL:
#
#   peer      the peer namespace, both peer labels     must connect
#   sibling   the peer namespace, the app label, a     must be refused: the
#             different instance                       instance is what tells
#                                                      connectors apart
#   stranger  a namespace of its own, no labels        must be refused
#
# The peer's success is what makes the two refusals mean something: the same
# image and command, one label apart, reached the server.
#
# usage: np-probe.sh <url> <peer-namespace> <app-label> <instance-label> <image>
# The KUBECONFIG in the environment selects the cluster. Requires: kubectl.
set -euo pipefail

if [ "$#" -ne 5 ]; then
  printf 'usage: %s <url> <peer-namespace> <app-label> <instance-label> <image>\n' "${0##*/}" >&2
  exit 2
fi
url="$1"
peer_namespace="$2"
app="$3"
instance="$4"
image="$5"
readonly STRANGER_NAMESPACE='obsync-np-stranger'
readonly BUDGET_SECONDS=90

printf 'np-probe: START url=%s peer=%s/%s/%s budget=%ds\n' "${url}" "${peer_namespace}" "${app}" "${instance}" "${BUDGET_SECONDS}"
kubectl create namespace "${STRANGER_NAMESPACE}" >/dev/null

# One pod, one attempt, its exit code as the verdict. `wget -T 5` gives up on
# a connection the policy drops; an admitted one answers `/livez` at once.
attempt() {
  local name="$1" namespace="$2" labels="$3" code
  kubectl run "${name}" --namespace "${namespace}" --image "${image}" --restart Never \
    --labels "${labels}" --command -- wget -q -T 5 -O /dev/null "${url}" >/dev/null
  for _ in $(seq 1 "${BUDGET_SECONDS}"); do
    code="$(kubectl get pod "${name}" --namespace "${namespace}" \
      --output jsonpath='{.status.containerStatuses[0].state.terminated.exitCode}' 2>/dev/null || true)"
    [ -n "${code}" ] && break
    sleep 1
  done
  kubectl delete pod "${name}" --namespace "${namespace}" --wait=false >/dev/null 2>&1 || true
  printf '%s' "${code:-none}"
}

peer="$(attempt np-peer "${peer_namespace}" "app.kubernetes.io/name=${app},app.kubernetes.io/instance=${instance}")"
sibling="$(attempt np-sibling "${peer_namespace}" "app.kubernetes.io/name=${app},app.kubernetes.io/instance=np-sibling")"
stranger="$(attempt np-stranger "${STRANGER_NAMESPACE}" "app.kubernetes.io/name=np-stranger")"
kubectl delete namespace "${STRANGER_NAMESPACE}" --wait=false >/dev/null 2>&1 || true
printf 'np-probe: peer=%s sibling=%s stranger=%s (wget exit codes; 0 is connected)\n' "${peer}" "${sibling}" "${stranger}"

[ "${peer}" = 0 ] || { printf 'np-probe: DENY the named peer could not connect (%s), so the refusals below prove nothing\n' "${peer}" >&2; exit 1; }
case "${sibling}" in 0 | none) printf 'np-probe: DENY a sibling with another instance label was %s\n' "$([ "${sibling}" = 0 ] && echo admitted || echo never run)" >&2; exit 1 ;; esac
case "${stranger}" in 0 | none) printf 'np-probe: DENY a pod outside the peer namespace was %s\n' "$([ "${stranger}" = 0 ] && echo admitted || echo never run)" >&2; exit 1 ;; esac
printf 'np-probe: SUMMARY the policy is enforced: the peer connected, the sibling and the stranger were refused, decision=pass\n'
