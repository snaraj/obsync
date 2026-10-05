# Bounded version scheduling experiment

Frozen before sampling. Change only one `std::thread::yield_now()` after the
version post enters its queue and before taking the journal lock. No sleep,
protocol or security/durability change. Three alternating pairs: baseline,
candidate, candidate, baseline, baseline, candidate, each with fresh native
Mac Obsidian profiles/account. Installed app 1.13.4; identical candidate plugin.

Each sample runs eight isolated 8 KiB notes, bursts of 2/4/128 notes and a
64 MiB plus one byte control. Exact independent disk bytes and persisted file/
version identities on both peers are mandatory; no filtering failed samples.
Record request counts/bytes and per-version observed batch size distribution.
Accept only if 128-note sender median ratio <=0.95 and all three pairs improve,
with median receiver and large-file ratios <=1.05. Single-note sender/receiver
p95 must not exceed baseline p95 by more than max(20 ms, 5%).

These same-host loopback HTTP/mock-keychain runs screen the lever; they cannot
establish TLS, device custody, mobile or deployed-route performance. No task
builds, VMs or emulators may run during measurement. Host-wide idleness is
unproven. Existing authentication, encryption, replay, integrity and flushes
remain enabled. Archive all failures and reduced evidence. The controller
finalizes every sample, deleting accounts/profiles/server state and logs.

Invoke `compare.py --source CHECKOUT --harness HARNESS --root FRESH_RUN
--plugin UNCHANGED_PLUGIN_DIST --baseline BASELINE_BINARY --candidate CANDIDATE_BINARY`.
After resolved sampling, remove the two copied input binaries and experimental
build output; retain recipes, patch and reduced results only.
