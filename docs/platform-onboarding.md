# Platform onboarding (what the platform repository must add)

Dated 2026-09-07. obsync follows the same production path as the sites:
signed image and OCI chart from this repository's publisher, a promoter-cut
Draft in the platform repository selecting the exact digest, Flux
reconciling a HelmRelease from a signature-verified OCIRepository. Items
below are platform-lane work and are tracked as platform issues; nothing here
is done from this repository.

**Posture (owner ruling 2026-09-07): private and owner-only.** The reference
deployment is a single-node cluster reached over private connectivity, LAN or
VPN. There is no public hostname, no public access application, and no public
route, and the running deployment is therefore `OBSYNC_EDGE=none`. Items 1 to
3 below describe the published-hostname path for a deployer who wants one:
they are optional and currently unused, and taking them means moving to
`OBSYNC_EDGE=cloudflare` at the same time, because in that mode the server
refuses any request without the edge's connecting-address and request-id
headers.

**Whatever fronts the Service**, privately or publicly, routes to
`http://obsync.obsidian.svc.cluster.local:8080` (the chart's Service is named
`obsync`, in whatever namespace the release installs into), and the pod label
an egress policy must select is `app.kubernetes.io/name: obsync`. Neither is
the namespace name: an egress rule selecting `obsidian` matches no pod this
chart renders.

1. **ADR revision** (published-hostname path, optional): ADR 0015 admits
   exactly two per-site Tunnels. A third per-app Tunnel (`obsidian`) with one
   hostname rule and the terminal 404 rule; same shape, its own token, DNS
   record, connector Deployment, and NetworkPolicy in `cloudflare-public`.
2. **Hostname** (published-hostname path, optional): one proxied CNAME on an
   existing Free zone (one hostname, `sync.example.org` standing in for the
   deployer's own); no new zone, no spend.
3. **Cloudflare Access (Free)** (published-hostname path, optional): one
   application on that hostname with an identity policy (one-time PIN to the
   owner's address) for the dashboard paths and a service-token policy for
   `/v1/*`. The plugin sends the service token headers when configured; the
   pairing code can carry them.
4. **Namespace and reconciler:** `obsidian` namespace (owner ruling
   2026-09-07), prerequisites,
   default-deny, OCIRepository with `platform.snaraj.dev/chart-release`,
   exact `ref.digest`, `oci://` chart URL, and the publisher's
   `matchOIDCIdentity`; HelmRelease shaped like the sites (`maxHistory: 2`,
   `driftDetection`, rollback remediation, `deploymentReady: true`).
5. **Storage:** two static local PersistentVolumes on `local-pie-ssd` under
   `/mnt/local-pie-ssd/obsidian/{blobs,journal}` (250 GiB and 4 GiB), node
   affinity to the node, `Retain`; pre-bound to the claims the chart creates,
   which are `obsync-blobs` and `obsync-journal` in namespace `obsidian`.
   Every object this chart renders is named for the application, `obsync`,
   and never for the namespace, so a volume pre-bound to a claim named after
   the namespace binds to nothing and the pod waits forever. Growth to 500 GiB later. Directory creation on the host follows
   the existing operator procedure for the sites' media directories.
6. **Secret:** `OBSYNC_SERVER_KEY` as a SOPS-managed Secret consumed by
   `secretKeyRef`; never a literal.
7. **Promoter:** one new acquisition profile for publisher `snaraj/obsync`
   and the receipt-contract closure extended to a third identity tuple.
8. **Resources:** requests 64 MiB / 100 m, limits 1 GiB / 2 cores on the
   Pi; single replica, `Recreate` strategy (the volumes are RWO).
9. **Deploy assurance:** the watchdog's drift grammar gains the `obsidian`
   workload so promotion is never silent.
