# Native ciphertext, detached key proof

These tools separate native production from detached cryptographic evidence.
They never stage/prepare/commit a rotation, alter native state/storage, replace
transport/host methods, or create a note. All notes and complete marked backups
must already have been produced through the ordinary device UI.

`native-ciphertext-capture.mjs` reads exactly one named synthetic note version,
the active generation's map, and that note's one referenced chunk through the
retained authorized desktop's existing transport. It uses the same owned lab,
candidate, process, asset and task-proxy guards as `desktop.mjs`. The native
engine must already be active and idle. It checks the note's independent disk
bytes before and after capture, and refuses a changing version or generation.
This bounded helper supports root-level synthetic Markdown notes up to 16 KiB.

Before revocation, retain the complete OLD backup through `desktop.mjs save-old`
and capture a settled ordinary note. The expected note record is the private
`note-NOTE_LABEL.json` produced by `desktop.mjs note NOTE_LABEL`:

```sh
node scripts/validation/mobile/native-ciphertext-capture.mjs "$RUN" before \
  --source "$CANDIDATE" --note-label before --backup old
```

After ordinary Block access, create a fresh different note and capture it with
the same OLD backup. The parent independently proves that the revoked phone's
credential was refused; this helper does not use that old credential.

```sh
node scripts/validation/mobile/native-ciphertext-capture.mjs "$RUN" access \
  --source "$CANDIDATE" --note-label after-access --backup old
```

After ordinary rotation has committed, retain its complete NEW backup through
the desktop UI, create another fresh different note, and capture it:

```sh
node scripts/validation/mobile/native-ciphertext-capture.mjs "$RUN" rotated \
  --source "$CANDIDATE" --note-label after-rotation --backup new
node scripts/validation/mobile/ciphertext-oracle.mjs "$RUN" --source "$CANDIDATE" \
  --baseline before --access-only access --current rotated
```

Capture outputs are exclusive mode-0600
`RUN/private/desktop/ciphertext-CAPTURE_LABEL.json` files containing ciphertext,
complete authenticated contexts, decrypted chunk IDs and the expected synthetic
note bytes. They contain no root, derived key, device credential or backup.
Their reduced `evidence/native-ciphertext-capture-LABEL.json` receipts bind the
private capture hash, source, decoder, generation and expected byte hash. Keep
the private files private; retain only reduced receipts in public evidence.

The detached oracle loads the candidate's crypto, suite-2, recovery and map
modules. Every compiled module in their transitive dependency closure must
occur exactly once, byte for byte, in the exact plugin bundle used by the
native fixture. The source must remain clean and at the capture head. The
oracle needs no live application, server, credential or network request.

The normal proof requires all of these before producing a PASS:

- OLD backup opens the baseline map, manifest and chunk to the exact bytes.
- OLD backup opens the later access-only capture to its different exact bytes
  in the same generation. Access refusal therefore does not imply key removal.
- NEW backup opens every rotated captured material to the exact new bytes.
- OLD backup fails to authenticate the actual rotated map, manifest and chunk,
  even with all current authenticated contexts and the chunk CID supplied.
  The oracle attempts crypto directly; it does not count a root-derived
  generation mismatch or an HTTP denial as cryptographic rejection.

Distinct `native-ciphertext-detached-crypto-*.json` and
`detached-negative-controls-*.json` receipts keep those assertions separate
from fault controls. Controls require tampered ciphertext and valid but wrong
contexts to refuse for every material. Substituting the NEW root into the
OLD-root slot must trigger the explicit `old_key_map_unexpected_open`
assertion; an unrelated exception or setup failure does not kill that control.
The main command runs both sets only after all positive opens succeed.

Offline tests generate synthetic ciphertext with pure candidate crypto. They
never claim native or physical-phone acceptance, and never instantiate a fake
native secret store:

```sh
OBSYNC_ORACLE_SOURCE="$CANDIDATE" node --test scripts/validation/mobile/ciphertext-oracle.test.mjs
OBSYNC_ORACLE_SOURCE="$CANDIDATE" node scripts/validation/mobile/ciphertext-oracle-mutations.mjs
```

These proofs cover captured suite-2 material and independent plaintext bytes.
Native pairing consent, full process termination/restart, phone refusal,
ordinary sync suspension during rotation, metadata secret exclusion and phone
OS custody remain separate journey evidence. Android-emulator outcomes remain
emulator evidence; hardware-backed storage and physical-phone acceptance are
not established by this oracle.
