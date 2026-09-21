# Platform onboarding (what a GitOps platform repository must add)

Dated 2026-09-07. This page is for a deployer who runs obsync the way this
project is delivered: a signed image and OCI chart from this repository's
publisher, a change in a platform repository selecting an exact digest, and a
reconciler applying a HelmRelease from a signature-verified OCIRepository.
Nothing here is done from this repository, and nothing here describes any
particular installation: every name, address, size and policy below is the
deployer's own choice (requirement 11).

**Posture.** The shape this chart is written for is a single-node cluster
reached over private connectivity, LAN or VPN, with no public hostname, no
public access application and no public route, which is `OBSYNC_EDGE=none`.
Items 1 to 3 describe the published-hostname path for a deployer who wants
one: they are optional, and taking them means moving to
`OBSYNC_EDGE=cloudflare` at the same time, because in that mode the server
refuses any request without the edge's connecting-address and request-id
headers.

**Whatever fronts the Service**, privately or publicly, routes to
`http://obsync.<namespace>.svc.cluster.local:8080` (the chart's Service is
named `obsync`, in whatever namespace the release installs into), and the pod
label an egress policy must select is `app.kubernetes.io/name: obsync`.
Neither is the namespace name: an egress rule selecting the namespace matches
no pod this chart renders.

1. **Tunnel** (published-hostname path, optional): one per-application tunnel
   with one hostname rule and a terminal 404 rule, its own credential, DNS
   record, connector workload and network policy. A platform that caps how
   many tunnels it admits has to admit one more first.
2. **Hostname** (published-hostname path, optional): one proxied record for
   one hostname (`sync.example.org` standing in for the deployer's own); no
   new zone, and on the free tier of a provider that offers one, no spend.
3. **Access policy (optional)**: one application on that hostname with an
   identity policy for the dashboard paths and a service-token policy for
   `/v1/*`. The plugin sends the service-token headers when configured; the
   pairing code can carry them.
4. **Namespace and reconciler:** a namespace of the deployer's choosing,
   prerequisites, default-deny, an OCIRepository with the chart release's
   annotation, an exact `ref.digest`, the `oci://` chart URL and the
   publisher's `matchOIDCIdentity`; a HelmRelease with the platform's own
   history, drift-detection and rollback settings. `deploymentReady` stays
   `false` until items 5 and 6 exist on the cluster: false renders every
   object with zero application replicas, so the claims can bind their volumes
   first; true, set by one reviewed values change afterwards, scales the
   Deployment to its one replica.
5. **Storage:** two static local PersistentVolumes on a local class, one host
   directory per role (`docs/kubernetes.md` builds exactly this), sized to the
   node's disk with the journal claim at or above the watermark floor
   (`docs/storage.md`), node affinity to the node that holds the disk,
   `Retain`; pre-bound to the claims the chart creates, which are
   `obsync-blobs` and `obsync-journal` in the release's namespace. Every
   object this chart renders is named for the application, `obsync`, and never
   for the namespace, so a volume pre-bound to a claim named after the
   namespace binds to nothing and the pod waits forever. Growing a volume
   later is a PV capacity edit and a claim resize. Directory creation on the
   host follows whatever procedure the platform already uses for host paths.
6. **Secret:** `OBSYNC_SERVER_KEY` as an encrypted, reconciler-managed Secret
   consumed by `secretKeyRef`; never a literal in a repository.
7. **Promoter:** if the platform cuts releases from an acquisition profile,
   one profile for the publisher `snaraj/obsync`, with its receipt contract
   extended to this identity tuple.
8. **Resources:** a single replica with the `Recreate` strategy (the volumes
   are `ReadWriteOnce`), and requests and limits sized to the node -- a small
   single-board machine wants a floor in the tens of mebibytes and a ceiling
   near its memory, and the server's own budget is in `docs/benchmarks.md`.
9. **Deploy assurance:** whatever watchdog the platform runs for drift gains
   this workload, so a promotion that never lands is never silent.
