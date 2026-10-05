# obsync CLI

A native Rust client with human output by default, saved contexts, and a
versioned JSON interface. Its command groups follow
[kubectl conventions](https://kubernetes.io/docs/reference/kubectl/conventions/).
It needs no Node runtime, npm package or downloaded filesystem helper.

This version implements local discovery, context plans, apply, recovery and
native installation. Authentication, server administration, Obsidian setup, MCP
and encrypted export/open return an explicit unsupported result.

## Discover commands

```sh
obsync --help
obsync help --all
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

Install prints the directory to add to PATH once. Keep that same `--prefix`
for later versions. Install copies the verified native binary and documentation, flushes the private
stage, publishes the complete directory, then reads back its exact inventory.
It changes no PATH, shell profile or context. To upgrade at the same executable
path, first uninstall the old verified package, then install the new verified
package into the same `--prefix`. The executable is unavailable between these
two steps; this is not a zero-downtime switch. Retain the original verified package
until uninstall has completed. Uninstall with its exact binding:

```sh
"$package/obsync" uninstall --from "$package" --prefix "$installation" \
  --manifest-sha256 "$manifest_sha256"
```

Changed or unknown files refuse removal. Retry the exact action after interruption;
`.pending` and `.removing` siblings are reserved for bounded recovery. The
`.lock` sibling retains the same inode and flushed target/manifest binding, so
concurrent processes lock the same file and interrupted cleanup stays identifiable.
Only after the installation, `.pending` and `.removing` directories are absent
may a new verified package replace the binding. A damaged or foreign binding
refuses with an explanation; deleting the lock is never an upgrade step.
On Windows, uninstall durably retires the installation path with the approved
write-through move. Cleanup is observed absent, but its directory deletions are
not proven durable across power loss (`cleanup_durable: false`); repeat the exact
uninstall to remove any matching retired files that reappear. POSIX also flushes
the cleanup directories. Never run uninstall from the installation being removed;
use the original independently verified package as shown above.
Contexts, server data and vaults are outside the installation inventory. On Windows,
if old cleanup entries reappear after power loss, different package bytes refuse
cleanup and remain untouched. This does not claim physical power-loss recovery
across a version change.

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

## Add and select a server

At a terminal, one command shows the change and asks `Apply? [y/N]`:

```sh
obsync context add home --server https://sync.example.org
obsync context list
obsync doctor
```

The first server becomes selected automatically. Use `--use` when adding a later
server to select it in the same change. `context use NAME` selects an existing
server; `context remove NAME` removes only its local settings. The `config
set-context`, `config use-context` and `config delete-context` spellings work too.
Use `--yes` to explicitly apply without a prompt. A pipe, `--non-interactive`,
`--plan`, or `-o json` returns a plan unless `--yes` explicitly requests a write.
`--yes` and `--plan` cannot be combined. A declined confirmation changes nothing.

Settings default to `$XDG_CONFIG_HOME/obsync` (or `$HOME/.config/obsync`) on Linux,
`$HOME/Library/Application Support/obsync` on macOS, and `%APPDATA%\obsync` on
Windows. `--config-dir` overrides this with an absolute private path. The same
ownership, ACL, local-filesystem and link checks apply to defaults and overrides.
Reads and planning create nothing; the first confirmed write creates missing
default directories privately. Existing permissions are never broadened.
Windows storage commands still require the independently verified OS trust receipt.

## Plan and apply for automation

Keep the exact plan workflow when a person or agent must review the change before
execution. For example:

```sh
obsync config set-context lab --server https://example.invalid -o json
```

Save the returned **`data.plan` object** in a private file, review it, then apply
its independently retained digest. Use the same `--config-dir` override on every
command when selecting a nondefault configuration:

```sh
obsync apply -f /absolute/private/plan.json --expect-digest DIGEST -o json
obsync config current-context
obsync describe context lab
```

Each plan binds the exact configuration path, prior state, revision and a
five-minute lifetime. Changed, expired, stale and cross-target plans refuse.
Identical unexpired replays return the durable receipt without applying again.
At a terminal, confirmation releases helpers and holds no configuration lock;
after confirmation, apply rechecks the exact planned revision. Time spent deciding
is excluded from the five-second execution budget, but the plan still expires.
A verified result that finishes late stays completed and reports the elapsed time
and deadline warning. Unconfirmed completion remains `unknown`.

Human results show the action and next step. `--verbose` adds revision and receipt
details; `-o json` preserves the machine contract. Contexts accept names, HTTPS
origins and optional expected instance fingerprints. They never accept credentials,
recovery material or vault keys. Saving an origin does not contact or verify its
server: outputs retain `verified_instance: null` and `server_contacted: false`.

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
