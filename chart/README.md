# obsync Helm chart

This chart installs the obsync server and nothing else: a Deployment, the two
PersistentVolumeClaims it writes to, a Service on port 8080, a ServiceAccount,
and a NetworkPolicy that refuses every connection this file does not name. TLS
is not in it — the server speaks plain HTTP and something you trust terminates
HTTPS in front of it ([`docs/architecture.md`](../docs/architecture.md)).
Obsidian on iOS and Android refuses plain HTTP, so that terminator is not
optional.

The defaults in `values.yaml` are the reference deployment's — a single-node
cluster on a Raspberry Pi — and they are fail-closed on purpose: zero replicas,
StorageClasses that exist on that one machine, and one ingress peer that exists
in that one cluster. Four of them are yours to replace. Everything else can
stay.

## 1. A namespace, a server key, and two volumes

```sh
kubectl create namespace obsidian

kubectl create secret generic obsync-server-key \
  --namespace obsidian \
  --from-literal=OBSYNC_SERVER_KEY="$(openssl rand -hex 32)"
```

`OBSYNC_SERVER_KEY` is 64 hexadecimal characters and the pod does not start
without it. It wraps every device secret at rest: keep a copy somewhere safe,
because a server that comes back without it cannot unwrap a single device and
every device has to be paired again. It is not the vault key and cannot decrypt
a note — that key never leaves your devices.

The chart creates CLAIMS, never PersistentVolumes. On a cluster with a dynamic
provisioner, naming your StorageClass below is all that is needed. On static
local volumes, create the two PersistentVolumes first and present each
directory owned by uid 65532, mode 0700, with root-owned parents: the server
takes ownership of nothing and refuses to start on a volume it cannot write
([`docs/storage.md`](../docs/storage.md), "Volume posture"). No `fsGroup` is
set, because a group-writable volume is refused.

## 2. Verify the chart, then install it

```sh
cosign verify ghcr.io/snaraj/charts/obsync:1.0.1 \
  --certificate-identity https://github.com/snaraj/obsync/.github/workflows/release-publisher.yml@refs/heads/main \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com

helm install obsync oci://ghcr.io/snaraj/charts/obsync \
  --version 1.0.1 \
  --namespace obsidian \
  -f values.yaml
```

Install the PUBLISHED chart, not a copy from git. The committed chart carries
an all-zeros image digest no registry can resolve, so a git copy fails at pull
time instead of deploying something nobody verified; the published chart
carries the digest the publisher resolved after the signature and the
vulnerability scan accepted it.

## 3. The four values that are yours

```yaml
# The replica switch. False ships as the default so the claims can bind and the
# Service can resolve before the volumes and the Secret exist; you have just
# created both.
deploymentReady: true

storage:
  blobs:
    className: your-storage-class
    size: 250Gi
    capacity: 250Gi
  journal:
    className: your-storage-class
    size: 4Gi
    capacity: 4Gi

# The ONE workload allowed to open a connection to this pod.
ingress:
  peerNamespace: ingress-nginx
  peerAppName: ingress-nginx
  peerInstance: ingress-nginx

# The address your devices reach the server at, port included when it is not
# 443. Leave it "" if you would rather not say.
publicUrl: "https://sync.example.org"
```

**`storage.*.className`** is your StorageClass, twice, and it is also the label
the dashboard shows for each volume. `size` is what the claim requests AND what
the server is told its capacity is, so it must not overstate the volume;
`capacity` is what you provisioned behind it, recorded as an annotation.

**`ingress.peer*`** is the deployment's one door. The NetworkPolicy admits
traffic from pods that match all three — a namespace by its
`kubernetes.io/metadata.name` label, and a pod by `app.kubernetes.io/name` and
`app.kubernetes.io/instance` — and denies everything else, in both directions
(the pod itself opens no outbound connection at all). All three are required
because one namespace often holds several connectors that publish the same app
name and differ only by instance: a policy naming two of them reads narrow and
behaves wide.

Read the three values off whatever terminates TLS for you:

```sh
kubectl get pods --namespace <its namespace> --show-labels
kubectl get namespace <its namespace> -o jsonpath='{.metadata.labels.kubernetes\.io/metadata\.name}'
```

That terminator has to run IN the cluster — an ingress controller, a tunnel
connector, a reverse proxy you deploy — because the policy names a POD. Traffic
that arrives from outside the cluster through a NodePort or a LoadBalancer is
not a pod and is not admitted.

**`publicUrl`** is the base of every link the server generates, including the
dashboard sign-in link the plugin asks for. Empty is a working answer, not a
gap: the server then hands out a relative link and each device resolves it
against the Server URL it is configured with. Set it, and it must be the exact
address devices use — scheme, host, and port when the port is not 443.

## 4. Read the setup token

At first boot the server writes a token to `v1/setup-token` on the journal
volume, mode 0600, never logged. It creates the account once and then remains
the dashboard's recovery sign-in, so keep it as carefully as the recovery
phrase.

`kubectl exec` and `kubectl cp` cannot read it: the image is distroless and has
no shell and no `tar` for either of them to use. That is the container this
project ships on purpose, so the file is read from the volume instead.

- **A local volume:** read it on the node that holds it, at the directory the
  PersistentVolume names.

  ```sh
  sudo cat <the path that PersistentVolume names>/v1/setup-token
  ```

- **Any other provisioner:** mount the `obsync-journal` claim read-only into a
  throwaway pod of an image you trust and read `/journal/v1/setup-token` from
  it, then delete the pod. Because this chart always supplies the server key
  from a Secret, that volume holds the journal and the token and no key
  material — but it is still the deployment's sensitive volume, so mount it
  read-only and nowhere else.

## 5. What "installed" looks like

`helm status obsync --namespace obsidian` reprints the chart's own checklist.
The pod goes Ready when `/readyz` says so, which it does only once both volumes
are writable and the journal has replayed — readiness here is a measurement,
never a hardcoded yes. From there, the device steps are in the
[README](../README.md).
