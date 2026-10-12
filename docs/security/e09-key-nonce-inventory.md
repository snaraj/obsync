# E09: key and nonce accounting note

Author analysis, 2026-10-12; **not an independent review or E09 PASS**.
Source: predecessor `482d512e027b57154bfac07b71ea2a706102642f`, approved plan
`83549f4c` E09/section 5, and its unchanged cryptographic operations. Source anchors below refer to
that predecessor. The implementation candidate corrects the comments identified
below; no cryptographic operation changes follow from this note.

## Actual encryption keys and calls

All AES-GCM calls use 12-byte IVs and 128-bit tags. Counts attach to actual
key bytes, not a CryptoKey handle, file, device, process or uploaded record.

| Actual key | Nonce and invocation scope | Source anchors |
| --- | --- | --- |
| Chunk `K_c = HKDF(K_d, chunk-label, cid)`; `cid = HMAC(K_d,P)` | Nonce is `HKDF(K_c, nonce-label, empty)[0:12]`. Same plaintext in one domain repeats the same key/nonce/AAD/ciphertext on every device/restart. One **distinct input**, not one encryption call per key. Different actual keys may share a nonce without GCM same-key reuse. Distinct-plaintext cid or derived-key collisions remain computational possibilities, not impossibilities. | `crypto.ts:432–460`; push `:283/:462`, repair `:281`, pull `:3581/:3626/:3635/:3646/:5071/:5348` also encrypt for comparisons. |
| Domain manifest `K_m,d = HKDF(K_d, manifest-label, domain_id)` | Shared by every file in that domain and every device. `encryptManifest` draws a random nonce for files, conflict copies, tombstones and v3 pause controls; v2 folder records use a derived nonce from `SHA256(AAD || plaintext)`. Random and derived callers consume ONE combined lifetime for this key. | `crypto.ts:355/:504–515/:545–593`; `sync/push.ts:934` chooses derived only when `manifest.v === 2`. |
| Map `K_map = HKDF(VRK, domainmap-label, empty)` | Separate key from `K_m,d`. Derived nonce from `SHA256(AAD || plaintext)`; all map changes across devices/restarts share this root-lifetime key. Reposting identical input repeats identical bytes. | `crypto.ts:368/:545–563`; `domainmap.ts:224–240`. |
| Pairing envelope `K_pair = HKDF(ECDH, PS, pair-label || pairing_id)` | Random nonce. Fresh ECDH pairs/code bind a new key to one pairing; creator UI clears `asking` before its one approval seal. Count actual seals if another caller reuses the same exchange/PS/id; do not infer a global lifetime from an API's name. | `crypto.ts:229/:250`; `pairing.ts:267–285`; `ui/modals.ts:425–441`. |
| Pairing vault details `K_details = HKDF(PS, pair-vault-label, pairing_id)` | Random nonce, separate from the envelope key. A repeated claim with the same pasted code can seal changed details under this same key; attempts count even when the claim/request fails. Ten-minute pairing expiry is not an invocation bound. | `pairing.ts:352–362`; `ui/modals.ts:898`. |

Request authentication uses a separate 16-byte random request nonce plus
HMAC/timestamp/server replay storage; it is not an AES-GCM IV. Key imports,
WeakMap handle caching, restarting, repairing, retention/GC and deleting old
versions do not reset the lifetime of unchanged key bytes. Existing access-only
revocation/Leave retain roots; proposed fresh-root rotation is unimplemented
and cannot currently supply a lifetime limit.

## Conditional mathematical bounds

For a fixed key, let `r` be random-nonce encryptions and `d` be distinct
derived `(AAD,plaintext)` inputs. Under independent uniform random draws,
HKDF acting as a suitable pseudorandom function for this composition, and
collision resistance of the input digest, a conservative bad-reuse bound is:

```
p <= [r(r-1)/2 + d(d-1)/2 + r*d] / 2^96
  = (r+d)(r+d-1) / 2^97
```

The cross-term matters for `K_m,d`: a random file IV can equal a derived
folder IV. Exact deterministic input repeats disclose equality but create no
new distinct-message equation; their AES invocations still count where an
invocation cap is required. Changed AAD cannot rescue different plaintext
encrypted under the same key/IV. This bound excludes broken RNG, primitive
failure/cryptanalysis and forgery/processed-block bounds; it is not a proof
of the full construction. For `Q=r+d`, illustrative values are:

| Q per key across all devices/restarts | Birthday union bound |
| --- | --- |
| `2^16` | about `2.71e-20` (`2^-65`) |
| `2^24` | about `1.78e-15` (`2^-49`) |
| `2^32` | about `1.16e-10` (`2^-33`) |
| `2^40` | about `7.63e-6` (`2^-17`) |

These are analyst calculations, not observed usage. Distinct chunk cid and
HKDF output collisions require separate 256-bit assumptions; applying a
96-bit birthday bound across chunks with different AES keys is incorrect.
Identical-chunk resealing is deterministic equality leakage and enables
confirmation when an attacker can cause a guessed plaintext to be encrypted
in the same domain; it is not randomized encryption of that content.

[NIST SP 800-38D §§8–8.3](https://nvlpubs.nist.gov/nistpubs/Legacy/SP/nistspecialpublication800-38d.pdf)
sets a `2^-32` distinct-input key/IV reuse target and a `2^32` total encryption
invocation limit for its random-IV construction, summed over every instance
using a key. The hash/HKDF-derived IV here is not §8.2.1's unique fixed-field/
counter construction; calling it “deterministic” does not establish that
construction's exemption. No NIST conformance claim follows. [RFC 5116
§§3.1/5.1.1](https://www.rfc-editor.org/rfc/rfc5116.html#section-3.1)
describes shared-key nonce coordination and GCM's severe reuse consequences;
[RFC 5869 §3](https://www.rfc-editor.org/rfc/rfc5869.html#section-3)
does not certify this application-specific composition.

## Demonstrated gaps and wording corrections

- `crypto.ts:541–542/:579–584`, `architecture.md:258–261/:685–686`, and
  `crypto.test.mjs:211–212` assert repeats occur **only** for identical input;
  a 96-bit truncation cannot establish that. The candidate now states: “Identical inputs
  repeat deterministically; distinct inputs can collide with bounded probability
  under the stated assumptions. Random and derived uses share one key budget.”
  The candidate also qualifies “costs nothing” and per-chunk key assumptions.
- `crypto.test.mjs:368–375` samples two random IVs; `:204–217` tests a few
  derived inputs; `:427–431` samples two root-size random outputs. These are
  regression samples, not lifetime or bad-RNG evidence. The existing forced
  `getRandomValues` override in `android-recase.test.mjs:678–686` affects only
  8-byte temporary names. No root/AES nonce forced-failure/repetition test or
  shared-key invocation accounting/limit was found in the examined runtime/tests.
- A disposable author probe transpiled predecessor `crypto.ts` **in memory**
  with pinned TypeScript 5.9.3 on Node 26.10.0: thrown RNG errors refused
  manifest encryption; repeated all-zero RNG output was accepted for two
  distinct equal-length sentinel plaintexts under one manifest key. Nonces
  matched and ciphertext-prefix XOR equaled plaintext XOR. Zero artifacts;
  no real CSPRNG failure or naturally occurring collision was demonstrated.
- Frozen fixtures are generated by WebCrypto/plugin code
  (`fixtures/generate.mjs`, `generate-pairing-v2.mjs`). Node API agreement is
  useful byte-composition evidence, not automatically a second cipher engine;
  the predecessor's `crypto.test.mjs:5–8` overstated its provenance; the candidate
  now distinguishes API agreement from independently implemented primitives. [Node's WebCrypto AES path](https://github.com/nodejs/node/blob/main/lib/internal/crypto/aes.js)
  invokes native `AESCipherJob`; independently pin actual engine provenance
  before claiming independent AES implementations. Rust core performs no AES.

E09 remains unresolved for the global `K_m,d`/`K_map` lifetime and forced-bad-
randomness acceptance. A focused issue candidate is **“Justify and constrain
shared AES-GCM key lifetime; test broken-RNG behavior”**: choose and review a
concrete aggregate bound/mitigation and pin negative expectations, then prove
it across device/restart/retry paths. No numeric current-use or full security
failure rate is established here. The candidate below has no runtime effect
and supplies no publication decision or independent verdict.

## Chosen replacement: RFC 5297 AES-SIV with one migration

Implementation contract, 2026-10-12; **activation and E09 acceptance remain
incomplete**. This supersedes the rejected per-input HMAC/HKDF/GCM proposal.
The author is implementing the mode and parsers separately from the live
migration; passing component tests do not make existing traffic suite 2.

Use [RFC 5297](https://www.rfc-editor.org/rfc/rfc5297.html)'s
AES-SIV-CMAC-512: two AES-256 halves, a 128-bit SIV followed by ciphertext,
and deterministic operation without a nonce. CMAC/S2V formatting follows the
specification; AES itself uses native WebCrypto CBC/CTR. CBC processes complete
prepared input in bulk; discard its extra PKCS#7 block when selecting the CMAC
result. CTR uses the specified mask and 128-bit counter. Authenticate the full
unmasked SIV before returning any plaintext. No JavaScript AES, runtime package,
custom GCM construction or alternative-mode fallback is introduced.

The [WebCrypto specification](https://www.w3.org/TR/webcrypto/) defines CBC/CTR
operations but does not mandate support on every host. Published vectors,
independent full-mode comparison, actual desktop and phone execution, memory
and latency checks are required. A native unsupported-operation refusal must
stop. The 64-byte derived key still originates from a 256-bit root; it does not
supply 512 bits of entropy. Equality, lengths and traffic remain visible.

### Exact context and key scope

All layouts below are byte concatenation. `prefix` is ASCII `obsync/seal/2`
followed by one NUL; `kind` is one byte; `U32` is four-byte unsigned big-endian.
Lowercase hex IDs decode to raw bytes: generation `G`, domain `D`, file `F`
and pairing ID are 16 bytes; parent IDs, SIDs and CID are 32 bytes.
Parents are unique, sorted bytewise, and capped at 64. SID order and legitimate
repeats are retained, capped at 65,536. Validate before allocation.

| Kind | Complete context `T` |
| --- | --- |
| 1: manifest, including folder/control/tombstone | `prefix || 01 || G || D || F || U32(parent_count) || parents || U32(sid_count) || sids` |
| 2: map | Same layout with `02`; require `F=G` and no SIDs; use the locally derived map domain |
| 3: chunk | `prefix || 03 || G || D || CID`; CID/context stay inside encrypted metadata, not a wire header |
| 4: pairing root envelope | `prefix || 04 || pairing_id || claimant_public_65 || creator_public_65` |
| 5: pairing vault details | `prefix || 05 || pairing_id`; creator key is not yet revealed at claim time |

Every operation uses the one-component AD vector `[T]` and
`K = HKDF-SHA256(B, utf8("obsync/seal-v2/siv"), T, 64)`.
For manifests/maps, `B` is the existing domain-manifest/root-map secret.
Pairing uses its existing ECDH/PS envelope secret or separate PS/details secret.
Keep the current creator commitment and meaningful two-screen comparison.
Select the key from local/paired authority; never try server-supplied roots.
The decrypted enrollment must bind its root to the locally derived generation.
There is no additional key-commitment or global freshness claim.

For chunks, separate identifier and cipher base derivations:

```
K_id = HKDF(K_d, utf8("obsync/seal-v2/chunk-id"), G || D, 32)
B    = HKDF(K_d, utf8("obsync/seal-v2/chunk-base"), G || D, 32)
CID  = HMAC-SHA256(K_id, P)
```

Use `B` and kind-3 `T` above for the SIV key, then `SID=SHA256(packet)`.
Opening verifies SIV and recomputes CID before release. Snapshot mutable inputs
before asynchronous work. Same context with different plaintext is ordinary
SIV use, not a one-message-per-key invariant. Domain-separated KDF outputs
need their joint pseudorandomness assumption, including adaptive verification
contexts; they are not literally independent random samples.

The existing wire version hash stays unchanged. Do not use the old
`contentVersionId` as the new security context: it flattens parent and SID lists
without counts. Moving a 32-byte value between those lists can preserve its
preimage. The new counted context must reject that substitution without relying
on a hash collision assumption. Ciphertext-dependent version IDs never enter
key derivation, avoiding a circular definition.

### Finite assurance and resource limits

Use the published deterministic-AE model, which admits equality leakage and
quotients repeated queries. [Rogaway–Shrimpton, Theorem 2 and Corollary 4](https://web.cs.ucdavis.edu/~rogaway/papers/keywrap.pdf)
give the conditional per-key composition below, after a KDF hybrid:

```
Adv <= Adv_KDF + sum_i(Adv_CTR,i + Adv_CMAC,i + (p_i*q_i + q_i)/2^128)
```

Index every actual queried scope, including attacker-selected verification-only
scopes; `q_i` includes seal/open queries and `p_i` counts their vector components.
Apply Corollary 4 with its stated `q >= 3` condition (pad a smaller query budget
upward for that corollary); do not substitute a one-query budget into its bound.
Retain reduction resources and the native AES multi-key terms inside the
component advantages. The paper's AES instantiation has processed-block birthday
scale, not an unlimited-lifetime guarantee. Define `sigma_i` conservatively over
both passes, AD, failed verifications and repeats across devices/restarts.
The normalized `sum(sigma_i^2)/2^128` scale is **not** a complete bound with
all constants and primitive terms evaluated.

The mode caps plaintext at 8 MiB, packet at 8 MiB + 16, AD count at 126 and
total AD at 8 MiB. Product wrappers use one AD component and the smaller layouts
above; existing manifest/pairing route budgets remain. These are per-operation
limits. They do not enforce a global quota on offline holders of a root.
For illustration only, one query per scope of at most `2^21` processed blocks
has normalized scale `2^-54` over `2^32` scopes, but `2^-22` over `2^64` scopes.
Repeated queries concentrated in one scope worsen the square. Neither example
is a measured workload, complete failure probability or acceptable-use promise.
A reviewed quantitative workload profile with component terms remains an
acceptance gate; counters, GC, key-handle imports and restart do not reset it.
Root, ECDH and identity generation still depend on healthy platform randomness.

### Framing, admission and recovery

Activate suite 2 and [fresh-root migration](device-revocation.md) together.
Chunks are raw SIV plus ciphertext, preserving the existing 16-byte expansion.
Version records explicitly carry `seal_suite:2` and `manifest_ct`; they have no
`manifest_nonce`. Pairing sealed objects likewise carry the explicit suite and
one packet. Legacy suite 1 has its old nonce field and is reachable only in the
explicit legacy operation. Reject mixed/unknown variants before decryption;
never try another decoder after failure.

Prepare/commit atomically record the account/generation minimum enrollment and
write suite. Honest-server setup, recovery, pairing, activation and publication
reject legacy or stripped capabilities after cutover, including requests already
queued before the fence. Persist this authority through journal replay and
compaction. Old server executables must refuse the new store rather than skip
an unfamiliar snapshot and resume from incomplete history. Updated clients
independently reject legacy records against their authenticated local pin even
when a malicious server permits an old client to write them.

Canonical recovery text is ASCII `obsync-recovery-v2`, one space, and 24 lowercase
English BIP39 words separated by single spaces. Input accepts only ASCII space,
tab, CR and LF as separators/outer whitespace, at most 512 bytes before trimming,
exact prefix/case/checksum and end-of-input. Unknown, duplicated, truncated,
suffixed or stripped prefixes refuse live recovery. Select live-v2 or legacy-
history parsing explicitly; never try/fallback. Repeated legitimate BIP39 words
remain valid. The prefix identifies a format, not freshness.

Bare legacy words stage detached history/migration bytes: no request, adoption,
credential change or engine start. Live recovery requires public explicit
`recover_only` capability, then a token-authenticated strict mode. In one durable
transaction require an existing account, its suite floor, valid proof or one
operator reset arm, and active enrollment. Stage the root until authenticated
resulting-state readback and the required current map match its derived identity.
A missing map stays pending. A lost one-time credential response stays unknown;
no nonexistent credential-readback service is implied.

Registered proof shows continuity with that verifier. After offline reset, the
new token/reset arm authorize choosing a verifier; the words can be wrong, and
the confirmation must say continuity is unproved. Verify/read back the complete
new backup and prepared local pin before migration commit. A lost/torn backup
confirmation cannot invalidate the only old recovery material. After cutover
old copies are history-only; software cannot prove offline-copy erasure. A valid
old backup without a trusted witness cannot prove it is newest.

### Bounded acceptance

Require fixed published CMAC/SIV vectors and an established independent full-mode
oracle; the same OpenSSL AES implementation under two wrappers is not a second
primitive implementation. Mutate context counts/roles/kinds, tag/mask, length
limits and plaintext release. Force nonce RNG failure/repetition to prove the
new sealing path does not depend on it; do not infer root RNG safety.

End-to-end negatives include old binary + stripped backup + generic setup,
capability stripping, absent-account recovery with zero mutations, withheld map,
old-root ciphertext after pin, failed/torn recovery enrollment, lost replies and
restart. Rotation additionally needs the complete cutoff/reseed/transfer matrix
in its contract. Each must preserve local edits and usable recovery. Native
persistence, physical phones, independent protocol acceptance and exact-head
release gates remain separate from component tests.
