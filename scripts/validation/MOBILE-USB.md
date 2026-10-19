# Narrow physical Android follow-up: adapter implemented offline, not run

Physical acceptance remains **NOT_RUN**. Emulator success cannot waive the
physical-device gate. Hardware-backed/OS-encrypted backing storage remains
**NOT_MEASURED** unless a separate narrowly authorized proof establishes it.

The existing controller is deliberately emulator-only: its serial guard,
private USB-disabled ADB, fresh AVD ownership and synthetic CA namespace mounts
must not be bypassed or relabelled as USB support. `android-usb.py` supplies a
separate one-serial owner and `targetKind: usb` makes the
same ordinary UI journeys, evidence/scanner and byte reader target-aware.
The adapter and focused tests run offline; actual USB execution remains NOT_RUN.

Required owner-supplied inputs are one explicitly authorized USB serial,
official Obsidian acquisition/APK pin, a fresh disposable test-vault path, and
a trusted HTTPS route to the same disposable server. No device, credential,
certificate or infrastructure discovery is authorized by this assessment.

The control boundary is one task-owned private ADB server, fresh private
keys and an explicit `--one-device SERIAL` filter, with every command additionally
using that server's `-P PORT -s SERIAL`. ADB documents this single-USB-device
server filter and explicit serial selection. Avoid global `devices`, host-server
reuse, emulator scans, wireless pairing and broad package/storage inventories.
The owner must authorize this new ADB key on that one device. The adapter waits
up to 60 seconds for this external owner action and fails if it remains unauthorized. Bind its fixed
Obsidian PID and existing WebView debugger socket; absence of that supported
socket is a real automation blocker, not permission to patch the signed app.
[Official ADB manual](https://android.googlesource.com/platform/packages/modules/adb/+/refs/heads/main/docs/user/adb.1.md)

TLS is the remaining infrastructure prerequisite. Stock modern Android does
not generally add a user-installed CA to a production app's default trust;
apps targeting API 24 and newer default to system roots. The present synthetic
localhost CA therefore cannot be reused on a stock USB phone through ordinary
user-certificate installation. Do not root the phone, mount its trust store,
change SELinux, alter the official APK's network security configuration, or
disable TLS verification.
[Android network security defaults](https://developer.android.com/privacy-and-security/security-config)

Two honest transport options exist, conditional on explicit owner inputs:

- An already authorized HTTPS hostname, matching publicly trusted certificate
  and device-reachable route to this exact disposable server/recorder.
- A cable-only data route: local ADB reverse to the host loopback TLS listener,
  with an owner-authorized DNS name that already resolves to device loopback,
  and a matching certificate chain the stock app trusts. The app URL retains
  that DNS name. `adb reverse` only maps ports; it does not change DNS names or
  certificate trust. DNS/domain/certificate authority and any resolver changes
  are additional prerequisites, not implied authorization here.

No suitable trusted hostname/certificate/route has been established by this
assessment. Creating a public tunnel, acquiring certificates, editing DNS or
changing a phone's resolver requires separate explicit scope. The existing
one-day self-signed localhost route is not a stock-phone workaround.

The conditional integration below supports only core pairing/SAS/consent and
native byte convergence with positive and wrong-host TLS controls. The remaining
full journeys and pretrust control remain unsupported for USB. Preserve emulator
and physical records as distinct observations; neither waives the other gate.

Cleanup may stop only the owned ADB server and its forwards, then remove only
the explicitly created test vault/plugin state through the authorized ordinary
workflow. Do not clear app data, uninstall the owner's app, inspect other vaults
or secret entries, or revoke unrelated debugging authorizations. Prove test
credential removal/fixture cleanup and retain any unresolved step as UNKNOWN.


Select the recorded Python 3.15 interpreter and use the private-file creation
recipe in [the acceptance guide](MOBILE-ACCEPTANCE.md#run). The standalone USB
configuration must also be an owned, single-link real file with mode `0600`;
after creating or regenerating it, run `chmod 600 "$PRIVATE_USB_JSON"`.

The adapter CLI is:

```text
"$PYTHON" -B android-usb.py --config PRIVATE_USB_JSON --run FRESH_EXTERNAL_RUN --child SAME_RUNNER_CHILD ARG...
```

Private schema 1 configuration:

```json
{"schema":1,"targetKind":"usb","ownerApprovedDedicatedFixture":true,"serial":"OWNER_SUPPLIED_SERIAL","source":"/absolute/clean/candidate","sourceHead":"40HEX","sdk":"/absolute/pinned/sdk","adbSha256":"64HEX","desktopRun":"/absolute/owned/desktop-run","seconds":7200,"vaultPath":"/storage/emulated/0/Documents/Obsync-USB-Test","apk":{"url":"https://github.com/obsidianmd/obsidian-releases/releases/download/vVERSION/Obsidian-VERSION.apk","sha256":"64HEX"},"trustedRoute":{"url":"https://OWNER_SUPPLIED_HOST:18473","transport":"adb-reverse","bindingSha256":"SHA256_OF_PRIVATE_TLS_BINDING_JSON","leafDerSha256":"SHA256_OF_OWNED_CERTIFICATE_DER"}}
```

`transport` is `direct` or `adb-reverse`. The route must already use the owned
desktop session's exact live TLS process, upstream server and listener port.
The endpoint's presented leaf must equal the owned certificate and pass strict
host system trust; WebView acceptance is independently required. These checks
run before any USB access. The session's current generated synthetic certificate
cannot pass. Supply explicit owner-authorized TLS materials through the existing
`trustedTls` configuration described below. This adapter does not obtain,
copy or discover certificate private keys.

The owner authorizes the fresh private ADB key outside code. The adapter reads
only the supplied serial's official installed Obsidian APK and fixed guest
properties, refuses a pre-existing test path, and requires the app already open
at ordinary onboarding. The shared driver's first USB onboarding step refuses
an existing configured vault before acting. Existing permission/OEM screens that
do not match the finite ordinary-control path fail; no app data is reset to make
them match. No root, trust changes, installation, uninstall or phone reboot is
performed. Physical reboot remains explicitly unsupported.

The adapter returns familiar `android.json`, `android-ready.json` and
`result.json` shapes with `targetKind: usb`. It reports connected hardware and
executed journeys, never a fresh physical environment or replacement for three
fresh emulator runs. It cleans only its ADB/helper groups, created reverse and
host private files. Ordinary Leave/test-vault removal remains a separate required
device cleanup result; host `cleanup: PASS` cannot stand in for it.

## Conditional same-runner core execution

The existing command dispatches the conditional USB core path:

```text
"$PYTHON" -B scripts/validation/mobile-acceptance.py --config PRIVATE_CONFIG --out FRESH_EXTERNAL_OUTPUT --mode core --runs 1
```

Retain the existing server/build/official Mac app/Node pins and add these fields
(the named hostname, certificate, key and USB serial are owner-supplied resources):

```json
{"tlsPort":18473,"trustedTls":{"hostname":"owner-provided.example","certificate":"/absolute/explicit/fullchain.pem","certificateSha256":"64HEX","key":"/absolute/explicit/private.key","keySha256":"64HEX"},"android":{"targetKind":"usb","sourceHead":"SAME40HEX","ownerApprovedDedicatedFixture":true,"serial":"OWNER_SUPPLIED_SERIAL","sdk":"/absolute/pinned/sdk","adbSha256":"64HEX","vaultPath":"/storage/emulated/0/Documents/Obsync-USB-Test","apk":{"url":"https://github.com/obsidianmd/obsidian-releases/releases/download/vVERSION/Obsidian-VERSION.apk","sha256":"64HEX"},"trustedRoute":{"transport":"adb-reverse","url":"https://owner-provided.example:18473"}}}
```

For this finite core path the already-authorized DNS name must already resolve
to loopback on host and phone. The supplied full certificate chain must be valid
for that name under both host and stock Android trust. The private key must be
unencrypted, owned, real, singly linked and mode 0600. Python verifies exact pins
and keypair without an interactive password prompt, copies only those explicit
files into the owned private run, and keeps `mobile-tls.mjs` unchanged. Strict
system-trust readiness and wrong-host checks must pass before USB access. No
system root is added. Missing resources or an unmatched route fail closed.

The desktop child generates the adapter's live binding/leaf hashes from this
owned TLS instance, then uses the **same** Android child, ordinary onboarding,
manual three-file plugin install/readback and ordinary enable, independent SAS,
upload consent, two-way native note creation and independent persisted-byte
proof. It omits synthetic-CA operations entirely, measures fixed software
metadata, and finally force-stops only the dedicated app after collecting proof.
Unknown permission/OEM screens fail the existing finite ordinary-control path;
no profile or permission state is wiped to make onboarding match.

The result is USB **CORE_ONLY**. `--mode full`, including direct child entry,
and multiple USB runs fail before launch. All full USB journeys remain explicitly
unimplemented; USB core cannot count toward three fresh full emulator runs or
waive the physical acceptance gate. The test vault and its native custody are
retained; app termination/host cleanup do not assert removal or key erasure.

The implemented `trustedTls` selection supplies the explicit TLS materials to
the same owned local session. Omitting it produces the emulator's synthetic
localhost certificate, which cannot satisfy stock-phone trust. The runner does
not acquire certificates or manage DNS, relays or tunnels.
