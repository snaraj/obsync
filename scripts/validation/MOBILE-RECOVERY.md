# Fresh recovery (J11)

The full `mobile-acceptance.py` runner invokes these helpers through the existing
owned `mobile-session.py`. This document describes that finite sequence for
review; only a completed run supplies runtime evidence.

The child must finish rotation first, capture the original and new backups via
ordinary controls, and retain the same real server. Native desktop SecretStorage,
the official application, and the candidate's three installed files remain real.
Before provisioning B, C or D, normally Quit every desktop. Force-stop the exact
owned Android package and independently prove its old PID/devtools socket absent.
Keep the owned emulator/session alive so the helper can verify that absence.
No fresh desktop contains paired metadata, credentials, a staged key, or a copied
keychain; `open` enables the plugin through normal author trust and sets its URL
through the visible settings control.

The holder accepts only `private/provision-recovery.json`:

```json
{"schema":1,"requestId":"fresh-B","device":"B","androidRun":"/absolute/owned/android-run","androidOldPid":1234}
```

The request must be private and written atomically. Await matching
`private/provision-recovery-result.json`, `result: "PROVISIONED"`. C and D use
fresh request IDs and slots. The holder settles exited desktop process groups before
launching the new official app and retains its Popen for final owned cleanup.
A live paired desktop is refused, never force-stopped by provisioning.
No new server, account, public tunnel, host certificate, or generic command is
accepted. The holder's active desktop becomes B, C or D; restarts of A are then refused.

Run the fixed UI helper as:

```text
node mobile/recovery.mjs PEER_RUN CLEAN_SOURCE B|C|D COMMAND [CASE]
```

All commands emit sanitized evidence `mobile-recovery-SLOT-COMMAND-TIME.json`.
Failures exit nonzero and preserve the generic failure receipt; plaintext inputs
and exception details are never emitted. Fixed private inputs are:

- `private/desktop/phone-old-recovery-backup.txt`
- `private/desktop/phone-new-recovery-backup.txt`
- `private/desktop/phone-unrelated-recovery-backup.txt` (generated negative control)
- `runtime/server/journal/v1/setup-token`
- `private/recovery-expectations.json` (for final independent readback)

The finite sequence is:

1. Provision B; `B open`; `B stage old`.
2. `python3 -B mobile-journal.py before --run PEER_RUN --slot B --case old-backup`.
3. `B setup-refuse-old`; same journal command with `after`. Both must PASS.
   The UI proves `bad_recovery_proof`, visible refusal, no adopted credentials,
   and unchanged local custody. The journal independently proves unchanged
   durable account state; volatile rate counters are outside this claim.
4. `B quit`; request fresh D after B's normal exit. `D open`; `D make-unrelated`;
   `D stage unrelated`. The candidate's backup codec encodes a fresh random root,
   distinct from both actual roots. Journal `before --slot D --case unrelated-backup`;
   `D setup-refuse-wrong`; journal `after`. All must PASS. `D quit` and provision C.
5. `C open`; `C stage wrong` then `C stage stripped`. Both must PASS locally
   with unchanged custody and no recovery attempt. `wrong` deliberately uses
   `notaword`: this is invalid-word syntax, **not** an unrelated valid-key test.
6. `C stage new`; journal `before --slot C --case wrong-token`.
7. `C setup-wrong-token`; journal `after --slot C --case wrong-token`. Both
   must PASS (`bad_setup_token`, visible refusal, unchanged local custody and
   full verified durable journal).
8. `C setup-correct`; `C readback`. This uses the real setup token and complete
   new backup through ordinary visible controls, without old-device approval.
   Leave C alive for the holder's final active-desktop check; holder cleanup
   stops every owned group before erasing private profiles and logs.

Before step 8, the parent creates this private input from **independent earlier
disk-read witnesses**, not from the recovered vault:

```json
{"schema":1,"sourceHead":"EXACT40HEX","generationHash":"SHA256_OF_CURRENT_GENERATION_UTF8","notes":[{"path":"Phone-before-123.md","sha256":"SHA256_OF_ORIGINAL_DISK_BYTES","generation":"retained"},{"path":"Phone-after-456.md","sha256":"SHA256_OF_CURRENT_DISK_BYTES","generation":"current"}]}
```

The helper requires both note generations, exact suite 2/current generation,
and independently reads recovered disk bytes. It reports counts and booleans,
not backup words, credentials, note paths, or note contents. Journal evidence
includes frame counts and byte count only; the private baseline retains complete
segment hashes/inodes. Every segment has verified framing/CRC. Partial, corrupt,
oversized, concurrently changed, or compacted history lacking the original
`suite2_setup` fails UNKNOWN. A mismatch never becomes an unchanged-state PASS.

Close the recorder only after all recovery UI/native witnesses have been
collected. The independent final confidentiality scanner and planted controls
still run under the parent; these helpers do not assert whole acceptance or
physical-phone hardware custody.
