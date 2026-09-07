# Platform onboarding (what the platform repository must add)

Dated 2026-09-07. obsync follows the same production path as the sites:
signed image and OCI chart from this repository's publisher, a promoter-cut
Draft in the platform repository selecting the exact digest, Flux
reconciling a HelmRelease from a signature-verified OCIRepository, one
per-app Cloudflare Tunnel. Items below are platform-lane work and are
tracked as platform issues; nothing here is done from this repository.

1. **ADR revision:** ADR 0015 admits exactly two per-site Tunnels. Add a
   third per-app Tunnel (`obsync`) with one hostname rule and the terminal
   404 rule; same shape, its own token, DNS record, connector Deployment,
   and NetworkPolicy in `cloudflare-public`.
2. **Hostname:** one proxied CNAME on an existing Free zone (proposed
   `obsync.naranjo.online`); no new zone, no spend.
3. **Cloudflare Access (Free):** one application on that hostname with an
   identity policy (one-time PIN to the owner's address) for the dashboard
   paths and a service-token policy for `/v1/*`. The plugin sends the
   service token headers when configured; the pairing code can carry them.
4. **Namespace and reconciler:** `obsync` namespace, prerequisites,
   default-deny, OCIRepository with `platform.snaraj.dev/chart-release`,
   exact `ref.digest`, `oci://` chart URL, and the publisher's
   `matchOIDCIdentity`; HelmRelease shaped like the sites (`maxHistory: 2`,
   `driftDetection`, rollback remediation, `deploymentReady: true`).
5. **Storage:** two static local PersistentVolumes on `local-pie-ssd` under
   `/mnt/local-pie-ssd/obsync/{blobs,journal}` (250 GiB and 4 GiB), node
   affinity to the node, `Retain`; matching pre-bound claims. Growth to 500
   GiB later. Directory creation on the host follows the existing operator
   procedure for the sites' media directories.
6. **Secret:** `OBSYNC_SERVER_KEY` as a SOPS-managed Secret consumed by
   `secretKeyRef`; never a literal.
7. **Promoter:** one new acquisition profile for publisher `snaraj/obsync`
   and the receipt-contract closure extended to a third identity tuple.
8. **Resources:** requests 64 MiB / 100 m, limits 1 GiB / 2 cores on the
   Pi; single replica, `Recreate` strategy (the volumes are RWO).
9. **Deploy assurance:** the watchdog's drift grammar gains the `obsync`
   workload so promotion is never silent.
