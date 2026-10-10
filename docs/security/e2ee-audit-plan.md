# End-to-end encryption audit plan

*For reviewers and contributors.*

Status: proposed plan, dated 2026-10-10, tracked in issue #344. It makes no
new security claim. The findings below are leads the audit starts from, not
its result. File and line references are at `c2796b7a` (1.1.7).

## 1. The promise under audit

The public claim, in the README, `docs/index.md`, the plugin manifest,
`SECURITY.md` and the [threat model](../threat-model.md):

> Notes, attachments and file names are encrypted on your device, and the
> server never receives the key.

The audit proves or refutes four properties against three observers: the
server's operator, anyone holding a copy of its volumes, and a
TLS-inspecting box on the path.

1. **Content.** None of them sees note contents or attachment bytes.
2. **Names.** None of them sees file names, folder names, the vault name or
   note titles.
3. **Keys.** None of them sees the vault key or any key that decrypts
   content.
4. **Integrity.** The server cannot alter, forge, swap or replay content
   without a device noticing.

What the server CAN see, its metadata, is not hidden by design. The audit
turns it into an exact, published list the maintainer has accepted. Today's
documents describe it less precisely than that, and they leave items out.

## 2. Why a dedicated audit

**The adversarial review protocol does not cover this.** `AGENTS.md` gives
every security-surface PR one independent adversarial review, and that
review audits the PR's diff. Code that has not changed is never re-audited,
and no document requires a whole-system, external or penetration review.

**Function-level tests exist, and they are good:** known-answer tests from
the published vectors, WebCrypto fixtures reproduced by the Rust core, round
trips, tamper and cross-domain refusals, and checks that a fake server never
receives a path or a test string.

**What is missing is the system-level test:** the real plugin against the
real server, with every stored byte, log line and transmitted byte searched
for the note text, the names and the keys. The one real-session scan,
`scripts/ci/observer.mjs`, was run by hand on 2026-09-29 and found nothing.
Nothing re-runs it, it did not cover the recovery proof, and it has not seen
1.1.7. Making that scan a CI gate keeps the promise true on every change,
not only on the day of the audit (W5).

## 3. What the inventory already shows

A read-only inventory of the plugin, the server, the CLI, the dashboard,
the tests and the published claims was spot-checked against the code.
None of these findings is a demonstrated leak of content, names or keys to
the server. F3, F4, F5 and F9 are places where the documents say more than
is proved.

**F1. Content, names and keys hold by construction.** Chunks and manifests
are AES-256-GCM. No request, URL, header or log line carries a path. The
server holds no content key and runs no AES. The plugin never runs code the
server serves: Obsidian's plugin manager installs it
(`plugin/src/main.ts:5603`). Supports properties 1 to 3.

**F2. Integrity is bound.** A manifest's AEAD binds the file id, the
parents and the chunk ids; each chunk is checked against its keyed id; the
server re-verifies chunk hashes and version ids. Supports property 4.
Rollback and withholding are untested.

**F3. Overclaim on chunk equality.** `docs/architecture.md:32-36` says the
server never learns "which plaintext two chunks share", and the comment at
`plugin/src/crypto.ts:443-445` says deduplication happens "without learning
anything about the plaintext". Chunk encryption is deterministic within a
domain (`plugin/src/crypto.ts:432-440`), so equal chunks have equal `sid`s,
which the server sees.

**F4. "Proven" rests on one manual run.** `docs/threat-model.md:44-47` says
"proven, not asserted" and points to the 2026-09-29 observer run. That run
is not in CI and has not covered 1.1.7.

**F5. Unlisted metadata.** `docs/threat-model.md:16-19` and `:25-26` list
what the server sees. They omit:

- the exact plaintext size of every version (`bytes`,
  `plugin/src/sync/push.ts:561` and `:942-955`). Since 1.1.7 a note can
  produce one version per burst of typing, so sizes and times trace the
  typing;
- the edge's country header (`crates/obsyncd/src/api/edge.rs:28-32` and
  `:144-147`);
- a 256-event activity history per device with address and country
  (`crates/obsyncd/src/storage/index.rs:22`);
- the device that wrote each version;
- tombstone flags;
- domain ids, which are stable for the life of the vault;
- stable folder ids;
- chunk equality (F3).

**F6. The recovery proof crosses the terminator.** At restore, a value
derived from the vault key travels in the setup request body; the server
keeps only its hash (`crates/obsyncd/src/api/setup.rs:72-80`). It is not a
content key, but neither requirement 6 nor the threat model names it.

**F7. Pairing v2 has no dedicated protocol review on record.** Its design
looks right. The pairing secret never crosses the server; it salts the
envelope key; a commitment plus a six-digit comparison code guards the
exchange. It shipped in 1.1.5 through the ordinary per-PR review. The
architecture asks for a key-agreement enrollment protocol to have "its own
protocol and cryptographic review" (`docs/architecture.md:557-559`, written
for the deferred recovery path). The audit applies that bar to pairing v2,
the key agreement that did ship.

**F8. Credential custody on the server.** Device secrets are XOR-masked
under a key derived from the server key, with no integrity check
(`crates/obsyncd/src/storage/mod.rs:491-500`). The server key sits on the
same volume unless `OBSYNC_SERVER_KEY` is set. The setup token is stored in
clear and doubles as the dashboard's recovery login
(`docs/security/dashboard.md:24`, `crates/obsyncd/src/api/admin.rs:286-289`).
This is not content, but it decides what a copied volume grants.

**F9. Doctrine and doc drift.**

- `AGENTS.md:121` names `TestBlindServer` and `AGENTS.md:194` names
  `TestProviderNeutrality`; neither test exists. The real scans are in
  `crates/obsyncd/src/doctrine_test.rs:91-124`, and they read source text,
  not output.
- `AGENTS.md:214-215` says the crypto fixtures come from the Rust core.
  WebCrypto produced them, and the Rust side copies them
  (`crates/obsync-core/src/hkdf.rs:151-152`).
- `docs/threat-model.md:192-195` promises OpenSSL differential tests for the
  primitives. Only SHA-256 has one, and it skips when no host tool is found
  (`crates/obsync-core/src/sha256.rs:335-341`).
- The provider-name scan (`crates/obsyncd/src/doctrine_test.rs:91-96`)
  misses the edge's header names (`crates/obsyncd/src/api/edge.rs:28-32`).
- The dashboard says the server has no key material to log
  (`dashboard/index.html:336`). It holds the server key and the setup
  token.

**F10. Residue on the device.** Error text redacts absolute paths only
(`plugin/src/vaultPath.ts:125-127`), so a relative vault path could reach a
plugin log line; this has not been traced. A legacy `data.json` can hold the
vault key and the device secret in clear until its first save
(`plugin/src/state.ts:468-470`). A previous secret-store revision keeps the
prior keys. All of this stays on the device, but it falls inside "keys never
leave".

## 4. Workstreams

### W1. Define the claim

- One canonical statement, "What obsync encrypts and what your server can
  see", in the threat model.
- The README, `docs/index.md`, the manifest description, `SECURITY.md`, the
  quickstart, recovery, the dashboard and settings text all align to it.
- Every claim maps to a test or a validation record.
- Fixes F3, F5, F6 and F9 in the documents. The W6 decisions come first.

### W2. White-box review of the whole system

One independent security reviewer works from the inventory, not from a
diff:

- **Key hierarchy.** Randomness; HKDF labels and separation (a domain key
  is both an HMAC key and HKDF input; the pairing secret is both salt and
  input); storage at rest; lifetime.
- **Revocation.** Revoking a device stops the server serving it, but no key
  rotates. The removed device keeps the vault key, so any ciphertext that
  reaches it another way, such as a copied volume or a colluding operator,
  stays readable to it. State this, and decide whether to rotate.
- **AEAD use.** The number of random nonces per key. For the deterministic
  nonces (chunks, folders, the domain map), proof that no two distinct
  plaintexts share a key and nonce. AAD binding.
- **Convergent encryption within a vault.** Equality leakage, and
  confirmation attacks (none are possible without the domain key).
- **A malicious server.** Rollback, fork, withholding, replaying a revoked
  device's versions, substituting the domain map.
- **Pairing v2,** as the dedicated protocol review in F7. Covers the
  commitment, the comparison-code strength, key substitution by the server
  or a proxy, and exposure of a code carried in a link.
- **Recovery.** The phrase's entropy: 24 words encode the vault key itself,
  with no KDF (`plugin/src/pairing.ts:498-500`). Proof versus verifier, and
  what a terminator can do with a captured proof.
- **Custody on the server** (F8). Should the reference deployment set
  `OBSYNC_SERVER_KEY`? Should the wrap become authenticated encryption?
- **Dashboard and CLI.** They hold no key and show no name. `export` takes
  a key and discards it (`crates/obsyncd/src/cli/export.rs:79`).
- **Logs** on both sides, including F10.
- **Plugin supply chain.** Release signing; the evidence digest; Obsidian's
  installer, which appends a marker to `main.js`; no self-update.

Output: findings ranked P1 to P3, each with a reproduction.

### W3. Dynamic proof by sentinel and key scans

- **Rig.** The lab server behind a recording TLS-inspecting relay
  (`observer.mjs` already records and scans), capturing the server's
  volumes, the server's log and the plugin's log.
- **Flows.**
  - setup, and pairing with the codes compared;
  - create, edit and co-typing;
  - rename, move, and folders;
  - attachments, and one large file;
  - delete, restore, and history;
  - pause, and a conflict copy;
  - leave and re-pair, and recovery from the phrase;
  - dashboard use.
- **Platforms.** macOS desktop, Windows (a local VM or a hosted runner),
  Android (an emulator), and a physical iPhone.
- **Needles.**
  - note text; file, folder and vault names; front-matter values;
  - a binary attachment pattern;
  - the vault key and the domain, manifest and chunk keys, exported from a
    test device;
  - the recovery words, and the pairing code and secret;
  - the recovery proof, as a needle derived from the key.
- **Encodings.**
  - raw UTF-8, and UTF-16LE and UTF-16BE;
  - base64 at all three offsets, and base64url;
  - hex in both cases, percent-encoding and JSON escaping;
  - NFC and NFD forms, and case folding;
  - compressed bodies, decompressed first.
- **Controls.** Every run has a positive control: a needle deliberately
  sent in clear must be found.
- **Exit.** Zero hits outside the documented credential fields, on every
  flow and platform.

### W4. Hostile-server suite

A deliberately malicious server, driven from tests, that:

- swaps, reorders, truncates or replays chunks;
- serves an older or a forked manifest;
- substitutes the domain map;
- injects a version from a revoked device;
- replaces pairing public keys or envelopes;
- withholds versions.

Required outcome:

- no plaintext or key is disclosed;
- every forgery is refused with a logged reason;
- rollback and withholding behave in a documented, visible way.

### W5. Continuous enforcement

This answers the unit-test question at the system level.

1. **A ciphertext-only invariant test in CI.** The real plugin engine (Node,
   real WebCrypto) talks to the real `obsyncd` binary over HTTP. It runs a
   sentinel corpus across the main flows, scans the server's volumes, its
   log and every recorded request and response in all the W3 encodings, and
   fails on any hit. It is mutation-proven: a mutant that sends a path or a
   key in clear must turn it red.
2. **An allowlist test for clear fields.** It pins exactly which fields each
   route sends in clear (`bytes`, `sids`, `parents`, `domain_id`, the device
   name and the rest). A new clear field fails until it is reviewed and
   documented.
3. **The observer's real-session scan in CI.** `compose-e2e` and the
   Obsidian end-to-end job already run real Obsidian against a real server.
   Route them through the observer relay and scan.
4. **Doctrine repair.** `AGENTS.md` names real tests, and the blind-server
   scan also covers serialized log output, not only source text.

### W6. Metadata decisions (the maintainer's)

Each comes with evidence and a recommended default:

- **Size.** Pad or bucket version sizes? Batch versions so the server sees
  bursts rather than typing?
- **The edge's country and the per-device address history.** Keep, shorten
  or drop?
- **Device names.** Keep the default (the platform plus a random tag)? Warn
  that names are visible to the server?
- **Chunk equality within a vault.** Accept and document it, or move to
  per-file keys, which costs deduplication?
- **Revocation without key rotation.** Accept and document it, or add
  rotation?

### W7. Report and sign-off

- `docs/security/e2ee-audit-2026-10.md`: method, evidence, findings and
  residuals;
- the corrected threat model and claims (W1);
- one issue per finding;
- the maintainer's sign-off on the final wording of the claim.

## 5. Sequence

| Phase | Work | Agent time | Maintainer time |
| --- | --- | --- | --- |
| 0 | Approve the scope | none | 5 min |
| 1 | W2 review by an independent security reviewer; W1 claim map; W3 rig on `observer.mjs` | 3–4 h | none |
| 2 | W3 scans on desktop, Android and Windows; W4 hostile-server suite | 3–4 h | none |
| 3 | W3 on the iPhone | 45 min | Unlock the phone |
| 4 | W6 decisions | none | 15 min |
| 5 | W5 gate and W1 doc fixes as one security PR, with an independent review and a cybersecurity review | 1 train | Merge |
| 6 | W7 report and sign-off | 1 h | Sign-off |

The audit changes nothing by itself. Its fixes and gates are proposed for
a future release. The maintainer decides which one: v1.1.8 or a dedicated
security release.

## 6. What "confident" will mean

- Every public claim maps to evidence, and every overclaim is corrected.
- Zero sentinel or key hits across all flows and platforms, both behind a
  TLS-inspecting relay and in the server's storage, with positive controls.
- The hostile-server suite discloses nothing, and every forgery is refused.
- The CI gate and the clear-field allowlist are merged and mutation-proven,
  so every PR proves the promise again.
- The independent whole-system review has no open P1 or P2 finding. The
  residuals are documented, and the maintainer has accepted them.
