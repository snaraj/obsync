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

## Candidate mitigation for checkpoint finding 6 — design pending review

This section proposes a protocol change against `ceadfe08b75076ec8f67e255a768c36373af6153`.
It is **not implemented, not independently accepted, and not E09 PASS**. The
current lifetime and broken-nonce-RNG findings above remain open.

A true aggregate AES invocation quota cannot be enforced by independent offline
writers holding the same key without an authoritative allocation/coordination
mechanism and rollback-resistant state. Per-device counters, server counters,
GC, restart and a local nonce cache do not establish that quota here. Fresh-root
rotation would end an old key's writing lifetime only after its protocol actually
excludes legacy writers; its proposed transaction is not today's mitigation.

The smallest candidate using existing primitives is to make each **distinct
immutable encryption input** select its own AES key, extending the chunk pattern
to manifests/maps and repeatable pairing vault details. Pairing envelopes should
use the same construction under a separate kind if approved, rather than leaving
a caller capable of repeated random-nonce seals. Chunks remain unchanged.

Let `B` be the existing scope secret (domain manifest key, root map key, pairing
vault-details derivation, or ECDH/PS envelope derivation). Never encrypt with `B`
in the new format. For exact plaintext bytes `P`, define:

```
T       = encode(seal_format, kind, scope_identity, existing_AAD)
K_id    = HKDF-SHA256(B, "obsync/seal-v2/id", T, 32)
K_seed  = HKDF-SHA256(B, "obsync/seal-v2/seed", T, 32)
D       = SHA256(P)
I       = HMAC-SHA256(K_id, encode(T, D))
K_enc   = HKDF-SHA256(K_seed, "obsync/seal-v2/key", I, 32)
N       = HKDF-SHA256(K_enc, "obsync/seal-v2/nonce", empty, 12)
C       = AES-256-GCM(K_enc, N, P, encode(T, I)), tag_length=128
```

`encode` must have one fixed, length-delimited byte layout, not ambiguous string
concatenation. Version/kind are finite tags. Scope includes the domain ID for
manifests, the map's reserved identity for maps, and pairing ID plus the existing
public-key binder for envelopes. Existing manifest AAD remains file ID plus the
**content** version binder; the wire version ID hashes the ciphertext and cannot
be fed back into its own key derivation. No clear path enters `T`. Every byte of
`P`, including JSON serialization differences, changes the commitment input.
Domain-separated sibling HKDF outputs and the subsequent keyed commitment/key
derivation need joint composition review; RFC 5869 alone does not prove it.

Carry `I` in a strictly versioned ciphertext header; authenticate that header and
`T`. **Do not transmit `D`: an unkeyed plaintext digest would disclose dictionary
confirmation of guessed paths/maps.** The reader checks version/kind/lengths,
derives the key/nonce, checks the supplied nonce against the derivation if the
existing nonce field remains, verifies GCM, then recomputes `I` before parsing or
publishing any plaintext. Wrong context, malformed headers or a commitment
mismatch refuse without legacy fallback. Determinism reveals equality for the
same scoped context and enables confirmation by an actor able to cause guessed
plaintext to be sealed there. Server-visible lengths/timing remain; this does
not provide randomized metadata privacy.

### What this would bound, and what it would not

- Across honest peers, retries and restarts, identical `(T,P)` repeats the same
  key/nonce/AAD/ciphertext. A changed input selects a new key, conditional on the
  primitive assumptions. No shared counter or nonce RNG is required. Literal
  AES encryption calls remain unbounded; the bound is **one distinct input per
  actual AES key**, not one call. RNG health for roots/ECDH/identities is separate.
- For `Q` distinct inputs, a simple idealized union estimate for SHA-256 digest,
  HMAC identifier and 256-bit derived-key collisions is at most
  `3*Q*(Q-1)/2^257`, plus the relevant collision/PRF distinguishing advantages.
  At hypothetical `Q=2^64` this term is below `2^-127`. It is conditional, not a
  usage ceiling or a full confidentiality/authenticity bound. Matching 96-bit
  nonces across different AES keys do not constitute same-key nonce reuse.
- Require a metadata GHASH-input ceiling `ell <= 2^20` blocks per new seal/read,
  including AAD and its length block; this is above today's 4 MiB JSON wire
  ceiling and is not a new file-content ceiling. Thus each honest derived key
  protects at most one distinct record of that size. Repeated identical seals
  do not create new equations, but cannot be described as a NIST total-block cap.
- Keep 128-bit tags. NIST Appendix B's targeted-forgery scale is approximately
  `ell/2^128` per attempt (at this ceiling, `2^-108`), not universally `2^-128`.
  `V` failed verification attempts across peers/restarts are not globally capped;
  successful forgeries can change subsequent assurance. A full multikey bound
  must include `Q`, message lengths, verification attempts and primitive terms.
  The post-decryption commitment is an additional acceptance check, not a reason
  to omit that analysis. No fixed lifetime failure rate or NIST conformance is
  claimed. Independently reviewed quantitative composition is a release gate.

### Activation, migration and refusal

This changes ciphertext framing and derivation; it is not a comment-only fix.
A format marker belongs inside the opaque ciphertext container, so the existing
server need not learn `I`'s interpretation or gain a trusted counter. Pin exact
header sizes and existing route budgets before implementation. Preserve old
fixtures and use an explicit legacy decoder for authenticated historical data;
a failed v2 read must never try the legacy algorithm.

Writers must learn the required format from authenticated owner/domain state,
not the server's unauthenticated version manifest. Retain a local authenticated
format floor across restart; server rollback must not authorize legacy writes.
Fresh pairing/recovery must obtain the floor from authenticated owner/device
authority; a valid old map served to a fresh client does not prove it is current.
The proposed generation/rotation ceremony must close this bootstrap/rollback
boundary before activation. Prove supported client capability and block legacy
writers. Existing clients still holding old keys cannot be cryptographically
prevented from emitting legacy records: account-wide exclusion requires the
separately reviewed fresh-root/client-generation transition. If legacy records
remain writeable, this candidate only protects new-format records and E09 is
still unresolved for the old keys. Do not silently strand an old client.

Preserve legacy content/history for recoverability. An authenticated migration
must inventory/reseal every retained metadata object it promises to protect,
including remote-only live heads, folders, tombstones, pause controls and maps;
restart/lost-response resumes from durable progress. Previously exposed old-key
ciphertexts cannot be made secure retroactively. This key-use change neither
revokes root holders nor protects against a malicious paired writer holding `B`.

### Required negative and recovery cases before implementation acceptance

- Same exact input from two peers, retry and fresh process: identical bytes;
  changed plaintext (including same-size sentinels), AAD, kind, scope and format:
  distinct derived key inputs. Forced all-zero/throwing nonce RNG must not cause
  different records to share an AES key/nonce in this format.
- Substitute/truncate the header or `I`, supply wrong nonce/context, change tag or
  ciphertext: refuse before filesystem/UI publication, without legacy fallback.
  A deliberately mismatched commitment with an otherwise valid GCM seal must
  also refuse. Independent fixed byte vectors must cover the complete framing.
- Omit any context component, separation label, commitment recheck or size guard:
  a focused mutation must fail its intended assertion. Forced digest/HMAC/key
  collisions demonstrate the stated assumption failure, never a claim that all
  such collisions can be detected globally before encryption.
- Restart/rollback the advertised format, recover/pair an incompatible client,
  lose a migration response, and interrupt resealing with remote-only data:
  no automatic old-format write, no plaintext fallback, no lost recoverable data.

Review references: [NIST SP 800-38D §§8–9 and Appendix B](https://nvlpubs.nist.gov/nistpubs/Legacy/SP/nistspecialpublication800-38d.pdf)
and [RFC 5869 §3](https://www.rfc-editor.org/rfc/rfc5869.html#section-3).
This is **not AES-GCM-SIV** and does not inherit [RFC 8452](https://www.rfc-editor.org/rfc/rfc8452.html)'s proofs or bounds.
