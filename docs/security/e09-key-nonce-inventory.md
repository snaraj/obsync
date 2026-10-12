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
failure rate is established here, and this note proposes no key-management
redesign, runtime mitigation, publication or independent verdict.
