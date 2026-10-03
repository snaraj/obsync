# obsync CLI

A native Rust client with human output by default, explicit contexts, and a
versioned JSON interface. Its command groups follow
[kubectl conventions](https://kubernetes.io/docs/reference/kubectl/conventions/).
It needs no Node runtime, npm package or downloaded filesystem helper.

This development candidate implements local discovery, context plans, apply,
recovery and native installation. Release acceptance is incomplete, including
native Windows execution. Authentication, server administration, Obsidian setup,
MCP and encrypted export/open return an explicit unsupported result.

## Discover commands

```sh
obsync --help
obsync config --help
obsync cli search context
obsync explain context.add
obsync capabilities -o json
obsync agent instructions -o json
```

Use `COMMAND --help` for examples and flags. `-o json` and `-o jsonl` each emit
one bounded schema-version-1 envelope; errors retain that format and return a
nonzero exit code. Human errors go to stderr. `--non-interactive` never prompts
or opens a browser. Read aliases include `get contexts`, `get context NAME`,
`describe context NAME` and `explain OPERATION`.

## Build from an explicitly trusted checkout

Use the Rust toolchain pinned in `rust-toolchain.toml`:

```sh
cargo build --locked --release -p obsync-cli
./target/release/obsync --help
```

The binary uses only Rust's standard library and the internal `obsync-core`
crate. macOS custody reads ACLs through Apple-signed OS JavaScript for Automation;
Windows custody uses a fixed OS PowerShell 5.1 helper. These helpers are embedded
in the binary. Neither platform downloads or discovers an interpreter from PATH.
Windows starts one helper per local command and rechecks filesystem custody on
every request. Requests and replies are bounded and numbered; successful commands
also require a clean helper exit without extra output or errors. The helper stops
when the command ends and shares its five-second deadline.

## Verify and install a release

Supported package targets are Linux amd64/arm64, macOS arm64 and Windows amd64.
Each archive contains `obsync` (Windows: `obsync.exe`), `LICENSE`, `VERSION`,
`README.md`, and `package-manifest.json`. Linux release binaries are static.

Download `obsync-cli-VERSION-PLATFORM.zip` as data. Before extracting or executing
it, verify its publisher with an independently trusted GitHub CLI and the exact
full source commit of the selected release:

```sh
gh attestation verify "$archive" --repo snaraj/obsync \
  --cert-identity 'https://github.com/snaraj/obsync/.github/workflows/release-publisher.yml@refs/heads/main' \
  --cert-oidc-issuer https://token.actions.githubusercontent.com \
  --source-ref refs/heads/main --source-digest "$source_sha" \
  --signer-digest "$source_sha" --deny-self-hosted-runners \
  --predicate-type https://slsa.dev/provenance/v1
```

The verified release evidence binds
`artifacts.cli_archives[PLATFORM].manifest_sha256`. A checksum beside an
unverified archive does not establish publisher identity. Keep OS execution
protections enabled; a source build does not establish downloaded-binary acceptance.

Extract only into a new private directory: owned mode 0700 on POSIX, or an
owner-controlled protected DACL on local NTFS. POSIX files must be mode 0600,
with only `obsync` mode 0700. Parents must be protected, without symbolic links.
The selected user and OS administrator remain trusted.

From that verified package, use an absolute installation path whose parent is
already private. Variables below are explicit paths and the independently
verified manifest digest:

```sh
"$package/obsync" install --from "$package" --prefix "$installation" \
  --manifest-sha256 "$manifest_sha256"
"$installation/obsync" --version
"$installation/obsync" --help
```

Install copies the verified native binary and documentation, flushes the private
stage, publishes the complete directory, then reads back its exact inventory.
It changes no PATH, shell profile or context. Upgrade repeats this ceremony into
a new directory; select that executable explicitly. Uninstall using the original
verified package and exact binding:

```sh
"$package/obsync" uninstall --from "$package" --prefix "$installation" \
  --manifest-sha256 "$manifest_sha256"
```

Changed or unknown files refuse removal. Retry the exact action after interruption;
`.pending` and `.removing` siblings are reserved for bounded recovery. The
`.lock` sibling permanently retains the flushed target/manifest binding, so
concurrent processes lock the same file and interrupted cleanup stays identifiable.
On Windows, uninstall durably retires the installation path with the approved
write-through move. Cleanup is observed absent, but its directory deletions are
not proven durable across power loss (`cleanup_durable: false`); repeat the exact
uninstall to remove any matching retired files that reappear. POSIX also flushes
the cleanup directories. Never run uninstall from the installation being removed;
use the original independently verified package as shown above.
Contexts, server data and vaults are outside the installation inventory.

### Windows trust setup

After independently verifying the Windows package, open the OS **PowerShell 5.1**
through Windows itself. Inspect the fixed script printed by:

```powershell
$setup = & "$package\obsync.exe" windows-setup -o json | ConvertFrom-Json
$setup.data.script
```

Run that inspected script in the trusted PowerShell session. It creates a new
private `powershell.json` receipt under LocalApplicationData and prints its path
and SHA-256 digest. Retain both independently. Supply them to every storage or
installation operation:

```powershell
& "$package\obsync.exe" install --from $package --prefix $installation `
  --manifest-sha256 $manifest_sha256 `
  --windows-trust $receipt_path --windows-trust-sha256 $receipt_digest
```

No command chooses an ambient executable, weakens execution policy, grants
administrator rights or enables a network filesystem. The receipt pins the OS
PowerShell executable; OS libraries and the selected user's session remain trusted.

## A local context, end to end

Choose an explicit `--config-dir` on every context command. Its parent must
already exist; first apply creates only the private leaf. Planning creates no
configuration. For example:

```sh
obsync config set-context lab --server https://example.invalid \
  --config-dir /absolute/private/config -o json
```

Save the returned **`data.plan` object** as `/absolute/private/plan.json`, review
it, and pass its digest separately:

```sh
obsync apply -f /absolute/private/plan.json --expect-digest DIGEST \
  --config-dir /absolute/private/config
obsync config get-contexts --config-dir /absolute/private/config
obsync config use-context lab --config-dir /absolute/private/config -o json
```

Apply the selection plan the same way, then verify in a fresh process:

```sh
obsync config current-context --config-dir /absolute/private/config
obsync describe context lab --config-dir /absolute/private/config
obsync doctor --config-dir /absolute/private/config
```

`config delete-context NAME` also returns a plan. Removal changes only that local
association. Each plan binds the exact configuration path, prior state, revision
and a five-minute lifetime. Changed, expired, stale and cross-target plans refuse.
Identical unexpired replays return the durable receipt without applying again.

Contexts accept names, HTTPS origins and optional expected instance fingerprints.
They never accept credentials, recovery material or vault keys. A configured
origin or fingerprint is not verified server identity: outputs keep
`verified_instance: null` and `server_contacted: false`.

## Storage and recovery

Two bounded snapshots alternate under a kernel-held lock. Each snapshot contains
both context state and its receipts. The previous state remains complete while
the next slot is truncated and flushed, its body written and flushed, then its
checksum appended and flushed. Success requires independent readback.

Reads and doctor perform no repairs. An incomplete inactive snapshot returns
`recovery_required` (exit 10). Run:

```sh
obsync config recover --config-dir /absolute/private/config
```

Recovery retains the last complete state and discards only the incomplete slot.
A sealed checksum, schema or sequence mismatch refuses recovery. Read back before
retrying an unexpired original plan or creating a fresh one. Do not delete files
to clear a refusal. Unknown configuration files are never converted or removed.

The configuration holds at most 64 contexts and 64 unexpired receipts; each
snapshot is bounded to 128 KiB plus framing. Plans and arguments are bounded to
16 KiB; output to 64 KiB. Commands check a five-second deadline before effects
and responses; a blocking OS filesystem call cannot be forcibly interrupted.

| Exit | Meaning |
| --- | --- |
| 0 | Requested local result completed or plan produced |
| 2 | Invalid input |
| 4 | Integrity or private-custody refusal |
| 5 | State conflict or concurrent operation; read back and retry as appropriate |
| 6 | Unsupported capability or missing context |
| 7 | Deadline or write result unknown; inspect before retrying |
| 9 | Local I/O failure |
| 10 | Explicit recovery required |

## Validation

`cargo test -p obsync-cli` exercises real subprocesses and native filesystem
checks. `scripts/ci/cli-native.py` consumes the actual package and independently
checks snapshots, receipts, installation inventory, retained contexts and startup
latency. Windows CI additionally runs under an ordinary synthetic account and
checks another account cannot access the private fixture. These checks supplement
visible manual terminal journeys; a cross-build is not native acceptance.
