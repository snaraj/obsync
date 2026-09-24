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


## Native desktop recovery

An unmodified Obsidian 1.13.7 application used an isolated synthetic vault and
profile. The plugin bundle was built from the standalone #142 commit
`90a600e` (SHA-256 `897cc17ee059ddaee7de5eb106b52a058c3a0d7733288032bc91efde6f01c850`);
the local test server used the composed `71c6d98` recovery implementation.
UI actions used the native interface; no injected Obsidian API drove them.

1. A previously forgotten device showed the recovery explanation and action.
   The existing vault key and every local note remained available.
   ![Forgotten-device recovery entry point](../assets/account-recovery/142-forgotten-device-recovery.png)
2. Setup on the isolated server enrolled the vault and uploaded 217 files.
   Revoking its sole device showed the explicit recovery warning below, with
   Cancel focused first. The server accepted revocation because recovery had
   been registered. No token or phrase appears in these captures.
   ![Final-device revocation warning](../assets/account-recovery/142-revoke-warning.png)
3. Entering that server's setup token under **Set up or recover**, with the
   retained vault key, displayed **Account recovered and this device re-enrolled**.
   Sync returned to **idle**. The replacement identity was different, while
   all 217 local file hashes were unchanged and all 217 sync records returned.
   The device list retained the previous device as revoked.
   ![Replacement active device and revoked history](../assets/account-recovery/142-recovered-device.png)

The device list initially retained the old refusal until Refresh was pressed.
That observed #142 display defect is fixed by clearing the old identity's cached
list after enrollment and ignoring an older identity's late response or error;
five focused regressions cover both cases and server changes. The screenshots
above record the observed build, including the manual Refresh used in step 3.

For a manual bundle update, disabling and enabling the community plugin loaded
the new code. **Reload plugins** refreshed the installed-plugin list but did
not reload this running plugin. This validation made no changes to the owner's
usual Obsidian application or vault.

## Fresh-install phrase recovery

A second journey used a completely empty synthetic vault with no enrollment
or vault key, on desktop Obsidian 1.13.7 and candidate bundle
`7557e642f146659c8dfe3cf0e974f405d8ca904d6364898102ddaf5a92d3efed`.
The native **Restore or create** form accepted the existing vault's 24 words.
**Set up or recover** then accepted the isolated server's setup token and
enrolled the new device using the restored key's proof. The UI reached idle.
All **327 files** then present on the source device arrived with identical
SHA-256 hashes and 327 local sync records. Existing enrolled devices remained
available in this complementary test; the earlier journey separately proves
recovery after the sole active credential is revoked.

Words and token passed directly between the test UI and temporary automation
memory. Neither was logged, written into evidence, or captured. The token
field was cleared after submission. The surrounding settings screenshots in
the guide are sufficient to locate these controls without publishing a
secret-bearing dialog.

Together these prove retained-key re-enrollment and fresh-vault phrase recovery
on desktop. Two-device leave/switch scenarios and the phone remain distinct
checks.

## Current switch confirmation

The current `bd68df43…` bundle opened the Switch server warning in the recovered
synthetic vault while other test devices remained enrolled. The guide's new
capture is cropped from that actual dialog. Selecting **Cancel** returned to
the paired settings. No Leave or Switch submission is claimed: automatic
approval review blocked the proposed Enter-key test because it might revoke
the test device; explicit authorization for that submission is pending.
