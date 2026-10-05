# Version-only batch experiment, frozen before measurement

Compare candidate server/client batching against the prior candidate server/client.
Only ready encrypted version metadata from active sync pushes carrying an abort
signal is coalesced; setup, conflict-preservation and control posts stay immediate.
A dedicated delay shares the injected timer provider but not the retry sleep
overrides used to exercise address-wake behavior. Queued groups cancel
before sending when their sync signal ends. At most32 distinct files and
16KiB each with a4ms wait; chunk upload and later file-change guards remain intact.
The server authenticates the complete bounded body and uses its existing durable
group commit. Unsupported-route fallback requires coded404/not_found; ambiguous
responses reconcile each file. This is an isolated prototype, not a shipping claim.

Three counterbalanced fresh-account pairs: baseline,candidate,candidate,baseline,
baseline,candidate. Each uses native Obsidian1.13.4 with two independent profiles.
Run eight isolated8KiB notes, bursts of2/4/128 notes and64MiB+1 file. Both peers
must hold exact independent disk bytes and persisted file/version identities.
Inspect both native editor captures from every sample. All failures retained.

Acceptance frozen:128-note sender median candidate/baseline<=0.95 and every pair
improves; median receiver and large-file ratios<=1.05. Isolated-note sender and
receiver p95 must not exceed baseline p95+max(20ms,5%). No best-run filtering.
Record request counts/bytes and version batch histograms; changed transport counts
are expected, but output bytes/identities must agree. Each phase must have its
sender acknowledgment and receiver commit timestamp. HTTP latency is not fsync
latency. Known sentinel absence scans are not general privacy proof.

Native loopback HTTP with mock keychains screens the lever, not TLS/custody/mobile
or deployed server acceptance. No task test/build/VM/emulator runs during timing;
external host load and observer overhead are uncalibrated. Authentication, E2EE,
replay prevention, integrity and durable writes stay enabled. Every sample is
finalized in finally, removing profiles, accounts, raw logs and server state.
After resolved sampling remove copied inputs and owned build caches, preserving
only reduced evidence, recipes and exact candidate diff. No personal vault changes.

Run compare.py with --source CHECKOUT --harness HARNESS --root FRESH_ROOT,
--baseline BASELINE_SERVER --candidate CANDIDATE_SERVER,
--baseline-plugin BASELINE_DIST --candidate-plugin CANDIDATE_DIST.
