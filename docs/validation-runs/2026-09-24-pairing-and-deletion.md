# Pairing details and delete-versus-edit, 2026-09-24

The composed #141 and #178 changes passed `make check` with the repository's
pinned Node 26.8.2/npm 11.19.1 and Rust 1.98.0: 144 core tests, 369 server
tests, two CLI tests, 977 plugin tests, 70 dashboard tests and 767 contract
tests. Rust line coverage was 94.68%. The source and history secret scans
reported no leaks. The core suite retains its existing one ignored test.

Pairing details passed 17 focused plugin mutation probes (M510–M526) and five
server mutations for envelope size, nonce shape, base64 decoding, claim
storage and creator polling. Delete-versus-edit passed ten focused probes
(M650–M657 and recut M252/M253). Each compiled and was killed by its
corresponding behavioral tests. These focused runs do not substitute for the
final complete mutation matrix, which is still pending composition of the
remaining release changes.

The server keeps the claimant vault details sealed. The creator decrypts and
validates them before presenting approval; older claims without details stay
compatible. Tests cover a closed modal during decryption and invalid payloads
without consuming a claim or enrolling a device.

The delete-versus-edit regression includes two independently syncing clients,
a startup upload racing settlement, preserved deletion history, replay, and a
later edit. See [the research and decision record](2026-09-24-delete-edit-research.md).

These are automated results. Current native desktop and phone acceptance and
setup screenshots remain outstanding and are not claimed here.
