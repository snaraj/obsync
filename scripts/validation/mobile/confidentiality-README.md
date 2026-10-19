# Closed native confidentiality scan

Run only after the task TLS/recorder has closed cleanly and all UI backups,
native ciphertext captures and Android metadata exports have been collected.
This command performs no app, Android, network or native secret-store reads.
The server's fixed owned filesystem paths may remain present after transport
closure. A changing snapshot, absent/empty log, incomplete capture or exhausted
budget refuses PASS.

```sh
node scripts/validation/mobile/native-confidentiality-scan.mjs "$RUN" --source "$CANDIDATE"
```

The wrapper supplies `evidence/traffic-manifest.json`:

```json
{"schema":1,"sourceHead":"40-hex-head","observerSha256":"64-hex-hash","files":{"c1.up":{"sha256":"64-hex-hash","bytes":123},"c1.down":{"sha256":"64-hex-hash","bytes":123},"index.jsonl":{"sha256":"64-hex-hash","bytes":123},"complete.json":{"sha256":"64-hex-hash","bytes":123}}}
```

The complete raw capture remains exclusively under `private/traffic/`. The
manifest must enumerate every file with its exact size and hash. The script
uses the candidate's `readCapture`, `buildNeedles`, `scan` and `uniqueJson` from
`scripts/ci/observer.mjs`; opaque file scanning uses the unchanged
`assertNoNeedles` function extracted from the candidate's `scripts/ci/e2ee.mjs`.
Both scanner hashes are recorded. No parallel scanner implementation replaces
their interpretation or encoding coverage.

The supervisor writes private mode-0600 `private/confidentiality-inputs.json`:

```json
{
  "schema":1,
  "sourceHead":"40-hex-head",
  "notes":["private/desktop/note-before.json","private/desktop/note-after-access.json","private/desktop/note-after-rotation.json"],
  "backups":["private/desktop/phone-old-recovery-backup.txt","private/desktop/phone-new-recovery-backup.txt","private/desktop/phone-unrelated-recovery-backup.txt"],
  "nativeCaptures":["private/desktop/ciphertext-before.json","private/desktop/ciphertext-access.json","private/desktop/ciphertext-rotated.json"],
  "pairingCodes":["private/desktop/phone-pair-code.txt","private/desktop/round-before/phone-pair-code.txt"],
  "androidMetadata":["private/android-custody-before/metadata.json","private/android-custody-after/metadata.json"]
}
```

List every owned `note-*.json` and `ciphertext-*.json` in the desktop private
directory. Notes retain the driver's bounded synthetic `{path,text,sha256}`
schema. Each capture must match a known UI backup and reopen successfully with
the exact bundle-bound decoder. The backup inventory is exactly OLD, NEW and the valid but unrelated
recovery control, in that order; all three roots must be distinct. Both OLD
and NEW roots must have native capture coverage. The unrelated root must be
refused during recovery and cannot substitute for either capture generation. Pairing invitation files may be explicitly named in one owned
archive subdirectory. Metadata exports may also use
`private/android-metadata-PHASE.json`. All private paths must be owned,
nonlinked and mode 0600; no unrelated discovery occurs.

Needles cover the known synthetic paths/text, complete UI backups, root keys,
derived map/domain/manifest keys, suite-2 map and manifest SIV keys, chunk ID
keys, chunk base keys, chunk SIV keys and the supplied pairing invitations.
The command scans bounded server blobs and journal files only under
`runtime/server/{blobs,journal}`, plus the nonempty `private/server.log`.
Traffic and server inputs share a 64 MiB / 4096-file limit and a 60-second
budget. The server snapshot and closed capture hashes are checked again after
the detached controls.

Android metadata is checked for the production schema's forbidden credential
fields and every known content-secret encoding. Local note paths are legitimate
metadata and are not treated as metadata leaks. Raw API credential export is
not authorized: the script rejects a credential-witness input field, does not
extract credentials from the captured wire, and reports
`rawApiCredentialValueScan: "NOT_MEASURED"`. An in-app credential fingerprint or
boolean metadata check remains separate native evidence. This boundary does
not prevent the content confidentiality scan from passing.

The controls plant a known root and note path into an otherwise parseable
private copy of a captured HTTP request, and a known root into private copies
of server storage and logs. Each must produce an actual secret hit or assertion
failure. Native files are untouched; temporary copies are removed on failure
too. Normal and control outcomes have distinct reduced receipts:

- `evidence/native-confidentiality.json`
- `evidence/native-confidentiality-controls.json`

Only after every assertion succeeds, `private/scan-result.json` contains:

```json
{"schema":1,"result":"PASS","sourceHead":"40-hex-head","observerSha256":"64-hex-hash","captureManifestSha256":"64-hex-hash","receipts":["evidence/native-confidentiality.json","evidence/native-confidentiality-controls.json"]}
```

Receipts contain counts, hashes and coverage boundaries, never note text,
paths, endpoints, keys, invitation codes or backups. Pairing ephemeral key
inventory is explicitly unavailable; only known roots and their inventoried
derivations are covered. This scan does not establish Android OS encryption,
physical-phone behavior or complete API credential-sink correctness.

Offline checks use synthetic HTTP/file inputs and do not establish a native
confidentiality result:

```sh
OBSYNC_ORACLE_SOURCE="$CANDIDATE" node --test scripts/validation/mobile/native-confidentiality-scan.test.mjs
OBSYNC_ORACLE_SOURCE="$CANDIDATE" node scripts/validation/mobile/native-confidentiality-scan-mutations.mjs
```
