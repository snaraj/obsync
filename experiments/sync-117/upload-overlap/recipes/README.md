# Upload-existence overlap comparison

Frozen before native execution: three fresh-account pairs, in arm order
baseline/candidate, candidate/baseline, baseline/candidate. Same installed native
macOS Obsidian, exact server and plugin hashes in `evidence/artifacts.json`.
No task builds, VMs or artificial stress during comparison. Host-wide idleness
is not asserted. Transport is loopback HTTP; mock keychains and two local native
windows do not establish TLS, phone or deployed-network performance.

Each sample creates 128 synthetic 8 KiB notes, then one deterministic 64 MiB
plus one byte file. Sender request counts/body lengths and final version response
timestamps are observed. Receiver durable writer completion timestamps are
observed separately. A 20 ms predicate poll is reported as its own elapsed time,
not substituted for the event timestamps. After measurement both persisted
file/version identities and every disk byte must agree with the independent
fixture recipe; the root fixture filename inventory must agree exactly.

The acceptance rule is set before results: all three paired large-file sender
acknowledgement ratios must be below 1.0, with median ratio at most 0.95; median
small-note sender ratio and large-file receiver ratio must be at most 1.05.
Request counts and uploaded body bytes must not increase. Any failed byte,
identity, privacy or cleanup oracle rejects the candidate. A neutral/noisy result
rejects this optimization, retaining every result and the rejected source recipe.
These six samples are a bounded pilot, not a general statistical guarantee.

The candidate changes only the multi-chunk sender. The small-note path is a
control; no small-note improvement is expected. Encryption, request signing,
replay protection, server integrity validation and durable writes remain on.

`compare.py` uses the existing owned native lab. It keeps the launcher alive,
runs initial setup and pairing, executes `native-overlap.mjs`, and independently
attempts teardown/holder wait even after failure. It requires final cleanup before
reporting a sample PASS. It stops after a failed sample; a repaired series uses a
new directory and retains the old result. Visual captures require inspection
separately. No personal vault is attached.

After resolution, remove the exact copied `inputs/` artifacts and all generated
runtime/private data. Retain only these recipes, reduced evidence and inspected
synthetic captures. Production source is proposed only if the measured rule passes.
