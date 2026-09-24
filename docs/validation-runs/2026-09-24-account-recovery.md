# Account recovery, 2026-09-24

The owner selected setup-token plus vault-key-proof re-enrollment for #142.
The implementation derives a separate authentication proof from the vault key
using the existing HKDF-SHA-256 primitive and a new protocol label. The server
stores only its SHA-256 verifier, immutably, in the account journal and snapshot.
The derivation follows [RFC 5869](https://www.rfc-editor.org/rfc/rfc5869.html);
its exact inputs and credential trust boundary are in the protocol and threat
model. This is an author implementation record, not an independent security verdict.

Real-server regressions exercise authenticated registration, wrong-token and
wrong-proof refusals, last-device revocation followed by re-enrollment, the
same account and retained ciphertext, and continued refusal of the revoked
credential. Storage tests reopen both journal and snapshot state and reject
malformed stored verifiers. An unregistered legacy account remains fail-closed.
A registration cannot be retroactively inferred after all old credentials were
lost; the recovery guide states that upgrade boundary explicitly.

Plugin regressions cover first setup, a lost setup response, durable key storage
before enrollment, single-flight setup, key replacement during either network
or derivation waits, old-server compatibility, forgotten credentials on startup
and feed, sticky status, resetting after old writers drain, local note/key/address
preservation, direct revocation, two devices leaving in order, pairing from a
forgotten identity, and both paths of the server-switch dialog.

All 30 new plugin probes, M580–M609, compiled and were killed by the focused
behavioral suites. The first 28 used 114 tests; the final two used 116 after
adding their specific race regressions. The 15 server probes also compiled and
were killed; reproduce them from the repository root with
`python3 scripts/validation/account_recovery_mutations.py`. Plugin probes are
reproducible individually with the existing full-suite mutant runner. Final
full-matrix evidence belongs to the final composed release head.

The full `make check` passed after updating the onboarding mutation fixture
for the renamed button: 144 core tests, 373 server tests, two CLI tests,
988 plugin tests, 70 dashboard tests and 767 contract tests. Rust line
coverage was 94.69%; both secret scans reported no leaks. The core suite
retains its existing ignored test.

After composition with #141 and #178, `make check` also passed: 144 core,
375 server, two CLI, 1,001 plugin, 70 dashboard and 767 contract tests;
Rust line coverage was 94.73%, with no secret-scan findings.

Native S14, S39, S40 and S41 journeys and setup screenshots remain separate
acceptance work. No native result is inferred from these automated tests.
