# Unattended mobile acceptance

Run the official Android Obsidian application, the exact candidate plugin,
the real candidate server and an official native macOS Obsidian peer in
disposable environments. No public endpoint or manually operated phone screen
is needed. This is emulator acceptance; it does not satisfy the repository's
separate physical-phone requirement or establish iOS behavior.

## Run

Prepare the private pinned-input configuration described in
[MOBILE-SESSION.md](MOBILE-SESSION.md), plus `candidateBuildReceipt` pointing to
the clean candidate's private build receipt. Add this `android` object:

```json
{
  "sourceHead": "same exact candidate commit",
  "sdk": "/absolute/verified/android-sdk",
  "java": "/absolute/verified/java-home",
  "assets": "/absolute/private/android-assets.json",
  "systemImage": "system-images;android-35;google_apis;arm64-v8a",
  "gpu": "software",
  "port": 5584,
  "seconds": 7200
}
```

[ANDROID.md](ANDROID.md) describes the official APK and SDK/archive pins.
The runner verifies the installed inputs against those pins. It provisions a
new AVD, profiles, vaults, local server and private transport for each attempt;
it does not download tools or silently accept licenses. Keep the candidate
checkout clean and separate from the driver checkout. Commit the driver before
full acceptance: the runner checks each executable helper against its committed
blob and checks hashes again at completion. Do not edit a running driver.

Build the candidate with its pinned toolchain (`make plugin` and
`cargo build --locked --release -p obsyncd`) before recording artifact hashes.
The private build receipt consumed by Android has `sourceHead`,
`sourceClean: true`, and `pluginHashes` containing exactly `main.js`,
`manifest.json`, and `styles.css` SHA-256 values. These are checked against the
actual clean checkout and installed bytes; an input hash alone is not publisher
authenticity or a build attestation. Retain the build log and official application
acquisition/digest evidence alongside the run.

First validate the small path:

```sh
python3 -B scripts/validation/mobile-acceptance.py \
  --config "$PRIVATE_CONFIG" --out "$ABSENT_RUN_DIRECTORY" --runs 1 --mode core
```

`CORE_ONLY` proves the enumerated installation, native TLS, pairing, consent
and two-way persisted-byte assertions. It explicitly does not claim full
acceptance or a closed native confidentiality scan. Extend the same driver:

```sh
python3 -B scripts/validation/mobile-acceptance.py \
  --config "$PRIVATE_CONFIG" --out "$ANOTHER_ABSENT_RUN_DIRECTORY" --runs 3 --mode full
```

Only three consecutive fresh `FULL_PASS` attempts, including their cleanup,
produce aggregate acceptance. A failure stops the batch and remains in its
original output. After a diagnosed fix, use a new output directory and repeat
the complete batch; never relabel a failed attempt or discard it as a retry.

## What is measured

| Former phone assertion | Replacement evidence |
| --- | --- |
| Correct installed candidate | Independent installed APK and all three plugin-file hashes, clean candidate and driver hashes |
| Ordinary pairing and consent | Ordinary mobile/desktop controls; separately read fresh verification codes; creator approval and native consent result |
| Two-way synchronization | Notes created through each application's editor; host and ADB retrieve actual persisted bytes into separate exports and compare them to nonempty expected bytes |
| Idle/restart retention | More than three minutes without Android interaction; separately witnessed process death, guest reboot and desktop Quit/relaunch; native credential/generation fingerprints and byte readback |
| Background and offline recovery | Native Home with the same process alive, loss/restoration of only the owned local route, independent absence before and bounded arrival after reconnection |
| Access-only revocation and re-pairing | Authenticated server refusal and absent new mobile bytes; explicit Leave and a fresh ordinary pairing; existing bytes retained |
| Strong revocation | Actual post-rotation server ciphertext opens with the new UI backup and rejects the old key; access denial alone cannot pass |
| Interrupted rotation and recovery | Persisted checkpoints before real restarts; ordinary resume/commit; fresh native recovery profiles and a valid unrelated backup refusal |
| Selected-folder rename | Desktop direct case-only rename and Android two ordinary renames through a fresh intermediate name; retained exports of both peers' bytes and server-history snapshots at seed, each convergence and each five-minute quiet endpoint; preserved identities, ancestry and selection boundaries |
| Content confidentiality | Closed bounded captures, server records/logs and native metadata checked by candidate scanners; deliberately planted leaks must be detected |
| Evidence completeness | Missing/truncated/corrupted independent file exports and missing scanner evidence must fail; machine-readable cleanup and provenance receipts |

The driver uses scoped ADB for native permissions, lifecycle and independent
file retrieval; guarded WebView/desktop CDP operates ordinary application
controls. It does not seed enrollment, write receiving keys, replace native
SecretStorage, bypass consent or disable certificate verification. Acceptance
runs install the candidate unchanged and do not patch product behavior.
Detached broken controls mutate copies of evidence;
their results are separate from unmodified-product acceptance.

The pinned Android application refuses a direct case-only Files rename on its
shared filesystem. The Android-origin case journey therefore always performs
two ordinary UI renames through the fresh name `Obsync-case-rename`; it does not
try a direct rename and retry after failure. Both actions share the existing
180-second limit. Exact directory entries must prove each intermediate state,
and the final descendant bytes and identities must match the original snapshot.
The intermediate and original names must both be absent at completion. The
desktop-origin direct rename and both five-minute stability windows remain
required. This proves that supported workflow and synchronization; it does not
claim the official Android app supports a direct single-step case-only rename.

## Evidence and limits

`result.json` is the aggregate verdict. `driver-manifest.json` binds executable
inputs. Each attempt retains reduced `evidence/` receipts, byte exports and
the first failure. Controllers remove only their owned processes and runtime
data after proving process-group absence; cleanup failure prevents a pass and
preserves ownership records. Treat local evidence as private until reviewed:
temporary configuration and outer diagnostic files may contain local paths.
Never commit raw traffic, recovery backups, invitations or credentials.

Selected-folder evidence retains the expected fixture manifests before byte
collection, including when comparison fails. A successful phase also binds all
five byte-export sets and server snapshots by exact paths and hashes. Terminal
admission reopens these files; missing evidence or matching empty files cannot
pass. The snapshots retain the inputs needed to independently replay the
identity, history/ancestry and quiet-state comparisons after runtime cleanup.
Fresh recovery likewise retains its expected hashes and two actual recovered
files, including partial failed exports. Recovery notices are verified in the
ordinary full Recent view, where grouped toasts remain readable; authenticated
refusals, unchanged custody and absence of recovered content remain separate
requirements.

The emulator uses Android's real WebView, filesystem/permissions and native
credential-storage path. Its rooted userdebug image and temporary guest-only
system test CA are explicitly recorded limitations. Negative probes first prove
untrusted-certificate refusal, then valid TLS acceptance and wrong-host refusal.
This does not prove hardware-backed custody, stock-device trust installation,
OEM power management or iOS Keychain/WebKit behavior. See
[MOBILE-USB.md](MOBILE-USB.md) for the narrowly scoped physical-device boundary.
Raw API credential values are not exported or exhaustively scanned; content
secret coverage and metadata checks are separately named in
[mobile/confidentiality-README.md](mobile/confidentiality-README.md).

Offline regression guards run with `make mobile-harness`. Their passing result
is not a native acceptance result. Publish measured native results separately
under `docs/validation-runs/`, including every failed attempt and the exact
remaining release gates.
