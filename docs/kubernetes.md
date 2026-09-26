# Run the server on Kubernetes

This is the advanced path. [Docker and Compose](server.md) is the simple one,
and it is the right answer for almost every deployment: one host, one command,
two volumes you back up with a copy. Take this page when you already run a
cluster and want obsync to live there under the same GitOps, secrets and
certificate machinery as everything else you run.

[`chart/README.md`](https://github.com/snaraj/obsync/blob/main/chart/README.md)
is the chart's own reference and is not repeated here: the namespace, the
`OBSYNC_SERVER_KEY` Secret ceremony, the four values you must replace, and the
two ways to read the setup token off a distroless image all live there. This
page is what that reference deliberately leaves to the operator — the volumes,
the certificate, and the route your phone takes — written from the refusals a
first activation of this chart actually meets.

## Your cluster, your route

A Kubernetes homelab is a supported deployment shape. Cloudflare is optional:
your own ingress or reverse proxy can terminate HTTPS, and your LAN or VPN can
carry the private address. Set the chart's ingress peer selectors to the
terminator you actually run, and choose storage and certificates from your
own cluster. Keep the server's plain-HTTP Service private to that terminator.

Your network plugin must enforce Kubernetes NetworkPolicy for the chart's
network restrictions to take effect. Creating the policy object alone does not
prove enforcement; see the [Kubernetes network-policy requirements](https://kubernetes.io/docs/concepts/services-networking/network-policies/).
The installation checks below still apply whichever networking product you use.

## 1. Verify what you are about to install

Two artifacts, both signed keyless by this repository's publisher, both
verified before anything reaches the cluster. The versions below are the
release being installed -- `1.0.7` here, `X.Y.Z` and `vX.Y.Z` for whichever
release you took off the Releases page:

```sh
cosign verify ghcr.io/snaraj/charts/obsync:1.0.7 \
  --certificate-identity https://github.com/snaraj/obsync/.github/workflows/release-publisher.yml@refs/heads/main \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com

cosign verify ghcr.io/snaraj/obsync:v1.0.7 \
  --certificate-identity https://github.com/snaraj/obsync/.github/workflows/release-publisher.yml@refs/heads/main \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
```

Both flags are the check. Without `--certificate-identity` and
`--certificate-oidc-issuer`, `cosign verify` accepts a signature from any
identity in any issuer, which is not a weaker check but no check at all.

The published chart carries the image digest the publisher resolved after that
signature and a HIGH/CRITICAL vulnerability scan accepted it. The chart in git
carries an all-zeros digest no registry can resolve, on purpose: a copy taken
from a checkout fails at pull time instead of deploying something nobody
verified. Install the published chart.

## 2. Two static volumes, owned before anything runs

The chart creates CLAIMS and never PersistentVolumes, and the server takes
ownership of nothing: a mount point that is not owned and writable by uid
65532 is a refusal (`reason=unwritable`), a world- or group-writable one is a
refusal (`writable_by_others`, `writable_by_group`), and no `fsGroup` is set
because a group-writable volume would be refused too
([storage](storage.md), "Volume posture"). There is no init container that
could `chown` your volume, and that is the design: a container that can
re-own the volume holding the server key is not one this project runs.

This guide builds the single-node case: one node with its own disk, so the
volumes are static and local. Create the two directories on that node, as the
node administrator, before the chart is installed:

<!-- ci: k8s-volume-dirs -->
```sh
sudo install -d -m 0700 -o 65532 -g 65532 /var/lib/obsync/blobs
sudo install -d -m 0700 -o 65532 -g 65532 /var/lib/obsync/journal
```

`0700` and `65532:65532` are the whole rule. The parents must be root-owned
and closed, and no component of either path may be a symlink.

Then the class and the two volumes that bind to it. `local` rather than
`hostPath`, because a `local` volume carries the node affinity that says which
machine the data is on — a pod that lands elsewhere stays `Pending` instead of
starting on an empty directory:

<!-- ci: k8s-storage -->
```yaml
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: obsync-local
provisioner: kubernetes.io/no-provisioner
volumeBindingMode: WaitForFirstConsumer
reclaimPolicy: Retain
---
apiVersion: v1
kind: PersistentVolume
metadata:
  name: obsync-blobs
spec:
  capacity:
    storage: 250Gi
  accessModes:
    - ReadWriteOnce
  persistentVolumeReclaimPolicy: Retain
  storageClassName: obsync-local
  local:
    path: /var/lib/obsync/blobs
  nodeAffinity:
    required:
      nodeSelectorTerms:
        - matchExpressions:
            - key: kubernetes.io/hostname
              operator: In
              values:
                - sync-node
---
apiVersion: v1
kind: PersistentVolume
metadata:
  name: obsync-journal
spec:
  capacity:
    storage: 4Gi
  accessModes:
    - ReadWriteOnce
  persistentVolumeReclaimPolicy: Retain
  storageClassName: obsync-local
  local:
    path: /var/lib/obsync/journal
  nodeAffinity:
    required:
      nodeSelectorTerms:
        - matchExpressions:
            - key: kubernetes.io/hostname
              operator: In
              values:
                - sync-node
```

`sync-node` is your node's `kubernetes.io/hostname`; the two paths are the
directories you just created. `WaitForFirstConsumer` is why a claim can sit
`Pending` with nothing wrong: with no pod to place, the scheduler has not yet
chosen a node, so the binding waits. It binds the moment `deploymentReady`
turns the replica count to one. `Retain` keeps the volume when the claim goes
away, which is what you want for the volume holding every encrypted chunk.

## 3. The values that are yours

The chart's defaults are fail-closed rather than portable: zero replicas, a
StorageClass name from one cluster, one ingress peer from one cluster. None of
the three is a value you keep.
[`chart/README.md`](https://github.com/snaraj/obsync/blob/main/chart/README.md)
section 2 explains each of the four; this is the file that matches the volumes
above:

<!-- ci: k8s-values -->
```yaml
deploymentReady: true

storage:
  blobs:
    className: obsync-local
    size: 250Gi
    capacity: 250Gi
  journal:
    className: obsync-local
    size: 4Gi
    capacity: 4Gi
  mirrors: []

ingress:
  peerNamespace: obsync-ingress
  peerAppName: tls-front
  peerInstance: tls-front

publicUrl: "https://sync.example.org"
```

`size` is what the claim requests AND what the server is told its capacity is,
so it must never overstate the volume; `capacity` records what you actually
provisioned. Neither may be small: free space is declared capacity minus
tracked usage, and the refusal watermark is the LARGER of five per cent and
2 GiB ([storage](storage.md), "Free-space watermark and quota"). A journal
claim under 2 GiB is therefore full before its first write — the server answers
`507 journal_full` to everything, including the first `POST /v1/setup`, with
the volume empty and nothing else wrong. The three `ingress.peer*` values name the ONE workload allowed to
open a connection to this pod, by its namespace label and by both of its own
labels — a namespace often holds several connectors that publish the same app
name and differ only by instance, so a policy naming two of the three reads
narrow and behaves wide.

## 4. A TLS front, inside the cluster

The server speaks plain HTTP and something you trust terminates HTTPS in front
of it (requirement 7). On Kubernetes that terminator has to be a POD: the
chart's NetworkPolicy denies everything in both directions except traffic from
the one peer above, and traffic that arrives from outside the cluster through
a NodePort or a LoadBalancer is not a pod and is not admitted.

Any in-cluster terminator will do — an ingress controller, a reverse proxy you
deploy, the tunnel connector in section 6. What it needs is a certificate every
one of your devices already trusts, because Obsidian on iOS and Android speaks
HTTPS only and offers no "continue anyway". Two ways to get one:

- **A private authority**, installed once on each device. No prerequisites at
  all, and the per-platform steps are on the [Docker and Compose](server.md)
  page. It is the fastest route and the one that makes a new phone a chore.
- **A public certificate over the DNS-01 challenge.** The challenge is
  answered by a DNS record instead of by a connection, so the name may resolve
  only on your own network and nothing has to become reachable from the
  internet. It costs a DNS provider credential and a renewal job, and it is the
  one that makes a new device nothing but a URL.

The DNS-01 ceremony, with [lego](https://go-acme.github.io/lego/) as the ACME
client, as a Job or a timer beside the cluster:

1. **An account key and a certificate key, both EC P-256.** An EC256 leaf is
   what the terminator serves; every platform obsync runs on accepts it, and
   it is smaller and faster than RSA on a small single-board machine. Keep both keys off the
   cluster's general-purpose storage and treat them as credentials.
2. **One DNS provider credential**, scoped to writing TXT records in the one
   zone. It never needs to read or write anything else, and it is the only
   secret the renewal path holds.
3. **Issue**, then **install the result as a Secret** the terminator reads —
   `kubectl create secret tls obsync-tls --namespace obsync-ingress`, or
   whatever your GitOps encrypts, under the name the manifest below mounts.
   The certificate and its key are the only two files the terminator needs.
4. **Renew on a cadence, not on an alarm.** Let's Encrypt certificates last 90
   days and the conventional renewal window is the last 30, so a WEEKLY run
   that renews anything with under 30 days left has four chances to succeed
   before anything expires. Run it before the certificate is the thing that
   broke: `lego … renew --days 30` is a no-op until it is not.
5. **Restart or reload the terminator** when the Secret changes. A terminator
   that reads its certificate once at start keeps serving the expired one
   until something tells it otherwise — and the failure looks exactly like a
   broken device rather than an expired certificate
   ([troubleshooting](troubleshooting.md), "The certificate is not trusted on
   this device").

Issue the certificate BEFORE you scale the Deployment up. A terminator that
starts without one takes its own readiness down, and a readiness probe on the
proxy in front of obsync reports the proxy, never the app behind it.

Whatever you terminate with, it is the workload `ingress.peer*` names, so its
three labels must be exactly the three values of section 3 — a mismatch is not
a warning anywhere, it is a connection the NetworkPolicy drops. A minimal one,
with the certificate arriving as the `obsync-tls` Secret the ceremony above
produces:

<!-- ci: k8s-tls-front -->
```yaml
apiVersion: v1
kind: Namespace
metadata:
  name: obsync-ingress
---
apiVersion: v1
kind: ConfigMap
metadata:
  name: tls-front
  namespace: obsync-ingress
data:
  obsync.conf: |
    server {
      listen 8443 ssl;
      ssl_certificate /tls/tls.crt;
      ssl_certificate_key /tls/tls.key;
      # Requirement 8: files of any size take one path. A stock proxy caps a
      # request body at 1 MiB, and a cap here is a refusal the server never
      # made and cannot explain.
      client_max_body_size 0;
      # The change feed holds a request open for up to 55 seconds, so a
      # 60-second read timeout closes a healthy long poll.
      proxy_read_timeout 120s;
      location / {
        proxy_pass http://obsync.obsidian.svc.cluster.local:8080;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto https;
      }
    }
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: tls-front
  namespace: obsync-ingress
  labels:
    app.kubernetes.io/name: tls-front
    app.kubernetes.io/instance: tls-front
spec:
  replicas: 1
  selector:
    matchLabels:
      app.kubernetes.io/name: tls-front
      app.kubernetes.io/instance: tls-front
  template:
    metadata:
      labels:
        app.kubernetes.io/name: tls-front
        app.kubernetes.io/instance: tls-front
    spec:
      securityContext:
        runAsNonRoot: true
        runAsUser: 101
        runAsGroup: 101
        fsGroup: 101
      containers:
        - name: nginx
          image: nginx:1.29-alpine
          ports:
            - name: https
              containerPort: 8443
          securityContext:
            readOnlyRootFilesystem: true
            allowPrivilegeEscalation: false
          volumeMounts:
            - name: config
              mountPath: /etc/nginx/conf.d
              readOnly: true
            - name: certificate
              mountPath: /tls
              readOnly: true
            - name: cache
              mountPath: /var/cache/nginx
            - name: run
              mountPath: /var/run
      volumes:
        - name: config
          configMap:
            name: tls-front
        - name: certificate
          secret:
            secretName: obsync-tls
        - name: cache
          emptyDir: {}
        - name: run
          emptyDir: {}
---
apiVersion: v1
kind: Service
metadata:
  name: tls-front
  namespace: obsync-ingress
spec:
  type: ClusterIP
  selector:
    app.kubernetes.io/name: tls-front
    app.kubernetes.io/instance: tls-front
  ports:
    - name: https
      port: 443
      targetPort: https
      protocol: TCP
```

Pin the image to a digest you chose rather than to the tag above, for the
reason section 1 gives about the chart and the server. The proxy is the one
workload that reaches obsync, so its bytes are part of your deployment's
surface.

## 5. Read the setup token, and first boot

At first boot the server writes a token to `v1/setup-token` on the journal
volume, mode 0600, never logged. It creates the account once and then remains
the dashboard's recovery sign-in, so keep it as carefully as the recovery
phrase. The image is distroless, so neither `kubectl exec` nor `kubectl cp` can
read it — there is no shell and no `tar` for either to use. On the static local
volumes of section 2 it is a file on the node:

<!-- ci: k8s-token -->
```sh
sudo cat /var/lib/obsync/journal/v1/setup-token
```

[`chart/README.md`](https://github.com/snaraj/obsync/blob/main/chart/README.md)
section 4 has the route for every other provisioner — a throwaway pod with the
journal claim mounted read-only — and the ReadWriteOnce attachment rule that
makes it a scale-down rather than a second reader.

That token is what the plugin's first device is enrolled with, through the
deployment's own address: the account, the first device, and then a pairing for
every device after it (`docs/protocol.md`, "Setup and account"). Nothing on the
API answers before it has been used, and nothing but a signed request answers
afterwards.

## 6. Reaching it privately

Nothing on this page asks the server to become reachable from the internet. A
private deployment has two halves, and both are outside this chart:

- **An outbound connector in the cluster.** A tunnel connector opens a
  connection OUT to its provider and publishes one internal address — here,
  the obsync Service on port 8080 through the terminator. No inbound port is
  opened on your router and no address of yours is published. Run it in a
  namespace of its own, with a default-deny NetworkPolicy of its own, so a
  connector that is compromised reaches the one service it publishes and
  nothing else in the cluster.
- **A client the devices join.** A device VPN, an overlay network, or the
  provider's own client app, carrying the HTTPS port and resolving the name to
  an address the route reaches. The five things that must all be true on a
  roaming device are listed on the [Docker and Compose](server.md) page under
  "Reaching it from outside your LAN"; they are the same five here.

Which products answer those two halves is yours to choose, and the chart knows
none of their names: a tunnel provider with its own connector and client, a
WireGuard network you run, an overlay like Tailscale. What the chart DOES need
is the connector's three labels in `ingress.peer*`, whichever one you run.

If you choose Cloudflare's edge integration, set `edge.mode` to `cloudflare`.
The server then requires its connecting-address and request-id headers on every
request and refuses requests without them. For your own reverse proxy or
another provider, use `edge.mode: none`, even when that front end authenticates
users. Set `trustedProxyCidrs` only to the proxy networks whose forwarded
addresses you trust. Authentication at the edge does not require Cloudflare;
the plugin's optional service-token headers can serve another front end too.

## 7. One reference deployment, end to end

The sections above are decisions taken one at a time. This is the shape they
add up to, written as a deployment a reader would build rather than as an
account of anyone's own:

- A **single-node cluster** with a solid-state disk. One node, so the `local`
  volumes of section 2 have exactly one place to be; the same page works on a
  larger cluster once the node affinity names the machine that holds the data.
- **GitOps**: a reconciler applies a release of the OCI chart by version, with
  the values of section 3 in a repository and the server key in an encrypted
  Secret. Nothing is installed by hand, so the cluster is what the repository
  says it is.
- A **TLS front inside the cluster** (section 4) serving a certificate every
  device already trusts, issued over DNS-01 for a name that need not resolve
  publicly.
- A **connector in its own namespace**, behind its own default-deny
  NetworkPolicy, publishing that terminator and nothing else (section 6).
- **No public hostname, no inbound port, no NodePort, no LoadBalancer.**

What a deployment of this shape proves, and what it does not: it serves a
vault to the devices that can reach the private route, which is the property
this page is about. Whether a given release has been exercised on real devices,
and on which, is recorded per release under
[validation runs](validation-runs/README.md) rather than claimed here.

## 8. Upgrade and roll back

An upgrade is a chart version and an image digest, and both are verified
before either moves. `helm upgrade` with the new `--version`, or the
`HelmRelease` version if Flux owns it; the claims and their volumes are
untouched. `helm rollback obsync <revision>` returns to the previous release,
and because every reference is a digest, what comes back is the bytes that
were running rather than whatever a tag points at now.

Back up before either. The journal volume carries the token and the journal;
if you let the server generate its own key instead of supplying
`OBSYNC_SERVER_KEY`, it carries that too, and a server that returns without it
cannot unwrap a single device ([recovery](recovery.md)).

## 9. What CI proves about this page

`.github/workflows/helm-e2e.yml` builds the image from the commit under test,
creates a throwaway `kind` cluster, prepares the two directories and installs
the chart from THIS repository — with the volume commands, the StorageClass
and PersistentVolumes, the values file, the TLS front of section 4 and the
token read of section 5 READ OUT OF THIS PAGE rather than out of a copy kept
beside it. It waits for both claims to bind and the Deployment to go Available,
reaches `/readyz` through a port-forward and then again through the documented
terminator over HTTPS, reads the setup token off the node with the command
above, and runs a full device flow through that terminator: the account, a
second device paired, one file pushed and pulled back — larger than the 1 MiB
a stock proxy would have refused — and every unsigned, altered, stale or
replayed request refused by name. Then it upgrades the release on the digest
and rolls it back, and finds the account, both devices and the file unharmed by
two pod replacements. An edit to any of those blocks that nobody carries into
the gate fails the build.

What it does NOT prove, because a `kind` cluster on a runner cannot: the
DNS-01 issuance of section 4 (the leaf the terminator serves there is one the
job issues, so what is proven is the terminator and its wiring, never the
certificate), the private route of section 6, and the NetworkPolicy's
refusals, which are proven instead against the RENDERED policy by
`scripts/ci/chart_pins.py`. What the gate does hold is that the three peer
labels on this page and the three `ingress.peer*` values on it stay the same
three facts.

## Next

- [`chart/README.md`](https://github.com/snaraj/obsync/blob/main/chart/README.md):
  the namespace, the Secret, the four values, and the setup token.
- [Storage and durability](storage.md): every refusal the server can raise at
  startup, and what each one means.
- [Troubleshooting](troubleshooting.md): what a device shows when the route,
  the name or the certificate is the thing that is wrong.
