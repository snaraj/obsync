# Disposable Android controller

This helper owns one fresh native Android emulator and one bounded journey
command. It never provides physical-phone acceptance. Supply a clean candidate,
installed SDK/system image, Java, and previously acquired official artifacts.
It neither downloads packages nor accepts SDK licenses.

```sh
python3 -B scripts/validation/android-session.py preflight \
  --source "$SOURCE" --source-head "$HEAD" --run "$FRESH_EXTERNAL_RUN" \
  --sdk "$SDK" --java "$JAVA_HOME" --assets "$ASSETS"

python3 -B scripts/validation/android-session.py run \
  --source "$SOURCE" --source-head "$HEAD" --run "$FRESH_EXTERNAL_RUN" \
  --sdk "$SDK" --java "$JAVA_HOME" --assets "$ASSETS" \
  --seconds 14400 --gpu software --reverse "$LOCAL_TLS_PORT" \
  -- node /absolute/path/to/native-journey.mjs
```

The preflight starts nothing and creates no run. The run must be an absent
external directory with an existing parent; resolve platform aliases such as
`/tmp` to `/private/tmp` first. Existing data and symlinked output paths refuse.
There must be 20 GiB free. Console port 5584 is the default; select an unused
even port in 5554–5584 explicitly if needed. The default image is installed
`system-images;android-35;google_apis;arm64-v8a`, hardware profile `pixel_8`.
The bounded budget is 1–86,400 seconds, independent of any public tunnel.
Software rendering is explicit and recorded; a boot failure requires a new
run and an explicit alternate mode, never an invisible retry/upgraded PASS.

`ASSETS` is a private JSON record of independently acquired pins:

```json
{
  "apk": {
    "path": "/absolute/Obsidian-VERSION.apk",
    "sha256": "64 lowercase hexadecimal characters",
    "url": "https://github.com/obsidianmd/obsidian-releases/releases/download/vVERSION/Obsidian-VERSION.apk"
  },
  "archives": [{
    "path": "/absolute/platform-tools.zip",
    "sha256": "64 lowercase hexadecimal characters",
    "url": "https://dl.google.com/android/repository/platform-tools_VERSION-darwin.zip",
    "installRoot": "/absolute/sdk",
    "prefix": ""
  }]
}
```

Include pinned Google archives for platform-tools, emulator, command-line tools
and the system image, plus the official Adoptium Java archive. Each archive's
regular members are streamed and compared to the corresponding installed files;
`prefix` removes a leading archive directory before joining `installRoot`.
For example, command-line tools use `prefix: "cmdline-tools/"` and installRoot
`SDK/cmdline-tools/latest`; a Google image archive uses `prefix: "arm64-v8a/"`
and installRoot `SDK/system-images/android-35/google_apis/arm64-v8a`. A Java
archive can use its entire extracted parent as installRoot with empty prefix.
Archive and installed-byte mismatches, absent required tools/images and extra
runtime files refuse; SDK-generated `package.xml` files are the sole extra-file
exception. Symlink archive entries do not supply verified executable coverage.
Pins and claimed URLs are inputs, not publisher-authentication proof: acquire
and authenticate them independently and retain that acquisition receipt.

ADB has private homes, keys, loopback server port and fixed emulator serial.
The server uses `-L tcp:PORT` without `-a`; hostname listener syntax is unsupported
by the installed SDK. `adb-listener.json` proves its exact PID listens only on
127.0.0.1 at the selected port, using a PID/port-scoped `lsof` read.
`ADB_USB=0` disables USB initialization; `--one-device` adds another restriction.
`ADB_EMU=0` and `ADB_MDNS=0` disable automatic emulator/network discovery. The
controller registers only its owned emulator port on the private ADB server.
The [official ADB source](https://android.googlesource.com/platform/packages/modules/adb/+/refs/heads/main/client/main.cpp)
documents these environment gates in server initialization. Emulator networking
is disabled after boot unless `--online` is explicit; offline operation can
still use a specified `--reverse` route to a parent-owned local TLS terminator.
This does not configure TLS, trust certificates or weaken application transport.

The journey receives `OBSYNC_ANDROID_RUN`, `OBSYNC_ANDROID_SERIAL`, and
`OBSYNC_ANDROID_ADB_PORT`. The private live `android.json` records process
identities, SDK path, environment, reverse ports, source and expiry. Use the
scoped helper for controls; it refuses changed/expired ownership and missing
reverse mappings before forwarding a command:

```sh
python3 -B scripts/validation/android-session.py adb \
  --run "$OBSYNC_ANDROID_RUN" -- shell input keyevent KEYCODE_HOME
```

The real Obsidian APK is installed unchanged and the installed APK bytes are
read back independently. Its launch activity is resolved from the installed
package. Onboarding, native file-access/trust prompts and ordinary UI pairing
belong to the journey command. Never seed pairing state, authentication,
VRK material, native secret storage or trust exceptions. Copy only hash-verified
candidate plugin artifacts to a synthetic vault. Do not dump paired page text,
secrets or screenshots containing pairing/recovery credentials.

Readiness is not acceptance. The journey writes its own assertion receipts
under `RUN/evidence`; its exit code is the controller's journey outcome.
`android-ready.json` records real image facts, APK hash and fresh-profile proof.
`result.json` separately records journey and cleanup outcomes, budget/duration,
and the failure stage. A failed journey, lost emulator/server, timeout, signal
or incomplete cleanup cannot become PASS. Private stdout/stderr logs and
runtime state are erased after verified process-group absence, on failure too;
write useful sanitized journey errors to evidence before exiting. Failed prepare,
boot and install stages retain `startup-diagnostics.json`: the final 8 KiB of
each startup log and captured command stderr are reduced to 4 KiB per source,
with credential-related lines omitted and URLs, paths, addresses and long
identifiers redacted. Truncated leading lines are omitted. This promotion is
disabled once the journey begins; its failures require sanitized phase evidence. If a process
group remains, private ownership evidence is preserved and cleanup fails.

The foreground owner observes child exits through `waitid(WNOWAIT)`, reserving
each original leader PID even after it exits. This prevents PGID reuse while
cleanup signals the group and waits for all live members to exit. It then reaps
the leader last and verifies group absence, removes the entire AVD/keys/private logs and
removes the live manifest. SIGINT/SIGTERM take the same path. SIGKILL or power
loss cannot execute a finally block; the retained manifest requires explicit
identity-checked recovery. Do not sweep processes or profiles by name. Do not
launch another emulator concurrently with an existing acceptance run.

Run the stdlib behavioral negative controls without Android:

```sh
python3 -B -m unittest discover -s scripts/validation -p test_android_session.py -v
```

## Synthetic HTTPS trust on the disposable Android 15 image

`android-trust.py inspect --run RUN` proves the owned fresh userdebug profile,
verified official APK, SELinux Enforcing, reverse mappings, official image's
namespace-entry applet and nonempty system CA store before changing anything.
The installed `toybox nsenter` applet is used even where no `nsenter` symlink
exists. Android 15's [Conscrypt CA-store implementation](https://android.googlesource.com/platform/prebuilts/fullsdk/sources/+/refs/heads/androidx-constraintlayout-release/android-35/com/android/org/conscrypt/TrustedCertificateStore.java)
selects `/apex/com.android.conscrypt/cacerts` for the system roots.

First capture actual WebView rejection of the untrusted local HTTPS endpoint.
The private JSON receipt must contain `result: "PASS"`,
`untrustedRejected: true`, the exact `sourceHead`, and the actual probe facts.
Coordinate with the sole UI operator before setup: rooting adbd reconnects the
guest transport and invalidates existing ADB forwards, but does not restart the
application or zygotes. Then supply only the public synthetic one-day CA:

```sh
python3 -B scripts/validation/android-trust.py install --run "$ANDROID_RUN" \
  --ca "$PRIVATE_PEER_RUN/private/ca.crt" --ca-sha256 "$CA_SHA256" \
  --untrusted-probe "$UNTRUSTED_WEBVIEW_RECEIPT"
```

The helper verifies the CA pin, current validity, one-day maximum lifetime,
CA signing usage and certificate hash filename. It requires the rejection
receipt before requesting root. It then restores and checks the existing ADB
reverse mappings, copies every original system root into an owned guest-only
directory, adds the synthetic CA, and applies the original system-CA SELinux
label. It makes the Conscrypt mount private and bind-mounts that union into
only the explicitly named app/zygote/WebView-zygote namespaces. Every original
root must retain identical bytes, SELinux must remain Enforcing, and the
installed signed APK must remain identical. No downloaded helper, app patch,
host trust installation, TLS verification override, SELinux relaxation or app
restart is included. The complete AVD teardown removes the temporary trust.

`android-trust.json` reports INSTALLED, never product or TLS acceptance. The
parent must next show the actual unmodified Obsidian WebView accepts valid
HTTPS and rejects a wrong hostname, with the same one-day CA and endpoint.
An app restart, if needed to refresh cached trust, belongs to the sole UI
operator. This is a rooted userdebug emulator with a synthetic system root;
it does not prove stock physical-phone trust installation or acceptance.

The controller also exposes finite lifecycle operations on that same owned AVD:

```sh
python3 -B scripts/validation/android-session.py home --run "$ANDROID_RUN"
python3 -B scripts/validation/android-session.py restart-app --run "$ANDROID_RUN"
python3 -B scripts/validation/android-trust.py verify --run "$ANDROID_RUN"
```

`home` requires the original process to remain alive and Android's resumed
activity to leave Obsidian. `restart-app` force-stops only `md.obsidian`, proves
its old PID and exact devtools socket are absent, resolves the installed launch
activity, and requires a fresh PID/devtools socket. It never clears app data.
Native enrollment/key retention remains a separate product assertion. When the
app is already stopped, the receipt says STARTED and does not claim a previous
process/socket witness.

An actual owned guest reboot is a separate operation:

```sh
python3 -B scripts/validation/android-session.py reboot --run "$ANDROID_RUN" --boot-seconds 240
python3 -B scripts/validation/android-trust.py reapply --run "$ANDROID_RUN" \
  --ca "$PRIVATE_PEER_RUN/private/ca.crt" --ca-sha256 "$CA_SHA256" \
  --untrusted-probe "$UNTRUSTED_WEBVIEW_RECEIPT"
python3 -B scripts/validation/android-session.py restart-app --run "$ANDROID_RUN"
python3 -B scripts/validation/android-trust.py verify --run "$ANDROID_RUN"
```

Reboot first force-stops Obsidian so Android's stopped-package flag survives
boot, requires an independently changed kernel boot ID and completed boot,
requires the application still stopped, records whether reverse mappings
survived, and restores only the recorded mappings. It records synthetic CA
restoration as REQUIRED. `reapply` verifies the persisted owned union against
the original system roots and same pinned CA before remounting it in the new
zygote namespaces; no running app is required. `restart-app` refuses to start
app networking until the current trust receipt matches this boot ID. `verify`
then checks the fresh app inherited the expected root union and unchanged APK.
Reapply and verification write new receipts while preserving the original
installation record. These are actual emulator guest lifecycle witnesses,
never a claim of a physical-device reboot or physical native-key retention.
