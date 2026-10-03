# Offline management client

This source candidate implements local
discovery, context management and a read-only doctor. Export/open,
authentication, native setup, server operations and MCP return explicit
unsupported results. Publication and native installation evidence remain gates.

## Run from an explicitly trusted checkout

Use Node **26.10.0**, with no runtime packages. Install the pinned build compiler
and build the package before invoking it:

```sh
npm ci --prefix plugin --ignore-scripts --no-audit --no-fund
node cli/build.mjs
node cli/dist/cli/obsync.mjs --help
node cli/dist/cli/obsync.mjs cli search context
node cli/dist/cli/obsync.mjs schema context.add
node cli/dist/cli/obsync.mjs capabilities
node cli/dist/cli/obsync.mjs doctor
```

The source entry refuses runtime options/preloads it can observe. This check
cannot undo code Node already loaded. A released launcher must select a verified
runtime and clear unsupported runtime inputs before execution; source invocation
does not establish that guarantee. The package includes that launcher and an
immutable-directory installer. Its native installation claims remain gated below.

## Build and install

`node cli/build.mjs` compiles the native filesystem adapters with the
existing pinned TypeScript compiler and writes one closed package to `cli/dist`.
The source checkout needs the plugin's build dependency installed first. No
plugin or vault decryption module is included. No additional
runtime package, compiler or downloader ships. Candidate builds are marked
`candidate: true`; publication refuses them. Release builds bind the authorized
protected-main SHA and exact member hashes in `package-manifest.json`.

For a published release, download its `obsync-cli-VERSION.zip` as data into an
owned private directory. Before extraction or executing any file from it, verify
with an independently trusted [GitHub CLI](https://cli.github.com/manual/gh_attestation_verify),
using the full source commit from the selected release:

```sh
gh attestation verify "$archive" --repo snaraj/obsync \
  --cert-identity 'https://github.com/snaraj/obsync/.github/workflows/release-publisher.yml@refs/heads/main' \
  --cert-oidc-issuer https://token.actions.githubusercontent.com \
  --source-ref refs/heads/main --source-digest "$source_sha" \
  --signer-digest "$source_sha" --deny-self-hosted-runners \
  --predicate-type https://slsa.dev/provenance/v1
```

A checksum downloaded beside an unverified archive is insufficient. Extract only
after publisher verification, into a new private directory. The release evidence
binds `artifacts.cli_bundle.manifest_sha256`; supply that exact digest below.
Use an independently verified **Node 26.10.0** installation, including its linked
libraries. Its canonical executable and all ancestors must be owned by the OS or
selected user and protected from group/other writes; symlink ancestors refuse.
Package-manager installations with writable shared ancestors need a separately
verified private runtime installation. Moving an executable alone does not verify
its linked libraries. Runtime acquisition is an explicit prerequisite.

### Verified macOS runtime

The official standalone archive avoids a package manager's shared writable
ancestors. Use an independently trusted `gpgv` executable, assigned as the
absolute `$trusted_gpgv` path, to verify Node's signed checksums. This recipe
pins the [Node release keyring](https://github.com/nodejs/release-keys/tree/481637f813e912c4aa3622d7964ab426c97b8e8d)
and its SHA-256; it does not read or modify a personal keyring. Review the
authorized release fingerprints against [Node's verification instructions](https://github.com/nodejs/node#verifying-binaries)
before trusting that keyring. No downloaded program executes before verification.

Run in Bash on the selected Mac; the new private directory must not exist:

```bash
set -euo pipefail
umask 077
case "$(/usr/bin/uname -m)" in
  arm64) node_arch=arm64 ;;
  x86_64) node_arch=x64 ;;
  *) exit 1 ;;
esac
node_name="node-v26.10.0-darwin-$node_arch"
runtime_root="$HOME/.obsync-$node_name"
/bin/mkdir -m 700 "$runtime_root"
cd "$runtime_root"
/bin/mkdir -m 700 verify
/usr/bin/curl --fail --silent --show-error --proto '=https' --tlsv1.2 \
  'https://raw.githubusercontent.com/nodejs/release-keys/481637f813e912c4aa3622d7964ab426c97b8e8d/gpg-only-active-keys/pubring.kbx' \
  --output verify/pubring.kbx
printf '%s  %s\n' \
  140f2ad5260fd62773b6243ce8e1d3009645d558f121b8262c55e383dc285932 \
  verify/pubring.kbx | /usr/bin/shasum -a 256 --check
/usr/bin/curl --fail --silent --show-error --proto '=https' --tlsv1.2 \
  https://nodejs.org/download/release/v26.10.0/SHASUMS256.txt.asc \
  --output verify/release-checksums.asc
/usr/bin/env -i PATH=/usr/bin:/bin "$trusted_gpgv" \
  --homedir "$runtime_root/verify" --keyring "$runtime_root/verify/pubring.kbx" \
  --output - verify/release-checksums.asc > verify/SHASUMS256.txt
/usr/bin/curl --fail --silent --show-error --proto '=https' --tlsv1.2 \
  "https://nodejs.org/download/release/v26.10.0/$node_name.tar.gz" \
  --output "$node_name.tar.gz"
/usr/bin/awk -v name="$node_name.tar.gz" \
  '$2 == name { print; count++ } END { exit(count != 1) }' \
  verify/SHASUMS256.txt > verify/selected.sha256
/usr/bin/shasum -a 256 --check verify/selected.sha256
/usr/bin/tar -xzf "$node_name.tar.gz"
trusted_node="$runtime_root/$node_name/bin/node"
/usr/bin/otool -L "$trusted_node" > verify/linked-libraries.txt
/usr/bin/awk 'NR > 1 && $1 !~ /^\/usr\/lib\// && $1 !~ /^\/System\/Library\// { bad=1 }
  END { exit(NR < 2 || bad) }' verify/linked-libraries.txt
test "$(/usr/bin/env -i PATH=/usr/bin:/bin "$trusted_node" --version)" = v26.10.0
```

Keep this complete directory and the verification files while its installations
are in use. The library check refuses non-OS dependencies, including Homebrew
paths and `@rpath`; do not bypass it by copying one executable or library. The
OS libraries and loader remain trusted. The archive signature covers the
distribution; the install receipt's `runtime_executable_sha256` and launcher
hash cover **only the Node executable**, not its libraries or the operating
system. Native candidate installation exercises this prerequisite independently
of public obsync release provenance; the latter still needs its own receipt.

### Windows and Linux runtime prerequisites

Use the same pinned Node release keyring and signed-checksum verification
described above. Select exactly one signed checksum entry for the complete
official archive matching the target:

| Target | Node 26.10.0 archive |
| --- | --- |
| Windows x64 | `node-v26.10.0-win-x64.zip` |
| Linux x64 | `node-v26.10.0-linux-x64.tar.gz` |
| Linux arm64 | `node-v26.10.0-linux-arm64.tar.gz` |

Use an independently trusted `gpgv`; a successful signature check must precede
archive hash verification and extraction. On Linux, `sha256sum --check` can
verify the selected entry. On Windows, compare `Get-FileHash -Algorithm SHA256`
against the entry from the verified plaintext checksums, and stop on mismatch.
Neither an unsigned checksum nor HTTPS alone proves the release signer.

Extract the complete verified archive into a new private directory. Linux
requires owned mode 0700 custody with protected ancestors. Windows requires
local NTFS and a protected owner DACL allowing only the selected user, SYSTEM
and administrators; protect the directory before extraction. The installer
reads that custody and refuses an unsuitable runtime. Keep the distribution
intact and trust its OS loader and linked libraries independently. The native
CI checks executable bytes against the signed distribution and uses the runner's
trusted OS libraries; it does not validate an arbitrary user's runtime provider.

### Install the verified CLI

From the verified extracted package, on macOS/Linux:

```sh
/usr/bin/env -i HOME="$HOME" PATH=/usr/bin:/bin "$trusted_node" \
  cli/install.mjs install --prefix "$new_install_directory" \
  --manifest-sha256 "$manifest_sha256"
"$new_install_directory/obsync" --version
"$new_install_directory/obsync" doctor
```

The parent directory must already exist with protected ancestry. Installation
creates a private immutable directory and `obsync` launcher. Every launch checks
the runtime executable and bootstrap hash before Node executes, then validates
all package hashes before loading CLI code. Invoke it from a trusted process:
the Node environment is cleared, but the launcher cannot sanitize its parent
or code already loaded by the operating system. The OS, its loader, the selected user
and the independently trusted runtime/libraries remain trusted.

Upgrade uses the same ceremony and a **new directory**. Verify its version and
doctor output, then explicitly select that executable in your invoking tool.
No PATH, shell profile, old installation or context is rewritten. Uninstall from
the corresponding verified extracted package with `cli/install.mjs uninstall`
and the same `--prefix` and `--manifest-sha256`. Unknown or changed files refuse
before removal. Contexts, vaults and server data are outside the inventory.
After interruption, retry the exact action: `.pending` holds a bound partial
copy, and `.removing` holds an already disabled installation. Recovery never
deletes an unknown file or accepts a different package for the same directory.

### Windows candidate installation

Windows requires an ordinary user, local NTFS and an explicit trusted OS
PowerShell 5.1 receipt. Native acceptance must pass before Windows support is
advertised. Source invocation alone does not enable persistent commands.
The fixed helper and adapter are included in the verified package; export and
credential enrollment remain unsupported.

After independently verifying the package and Node runtime, open OS PowerShell
5.1 as your ordinary user. Its full executable path is derived below from the
OS system directory. `windows-setup` returns the fixed setup command from the
verified package; executing it creates one private directory and receipt.
Keep the receipt path and digest for installation and removal:

```powershell
$ErrorActionPreference = 'Stop'
$trusted_os_powershell = [IO.Path]::Combine([Environment]::SystemDirectory, 'WindowsPowerShell\v1.0\powershell.exe')
if ([Diagnostics.Process]::GetCurrentProcess().MainModule.FileName -ine $trusted_os_powershell) { throw 'Open OS PowerShell 5.1 first.' }
$setup = (& $trusted_node cli/install.mjs windows-setup) | ConvertFrom-Json
if ($LASTEXITCODE -ne 0 -or $setup.operation -cne 'cli.windows_setup') { throw 'Setup plan refused.' }
$trust = (& ([ScriptBlock]::Create($setup.command))) | ConvertFrom-Json
$trust_receipt = $trust.path
$trust_digest = $trust.digest
& $trusted_node cli/install.mjs install --prefix $new_install_directory `
  --manifest-sha256 $manifest_sha256 --windows-trust $trust_receipt `
  --windows-trust-sha256 $trust_digest
& $trusted_os_powershell -NoLogo -NoProfile -NonInteractive `
  -File "$new_install_directory\obsync.ps1" --version
```

The native launcher clears inherited runtime inputs before starting Node.
Its fixed read-only custody checks run in that same PowerShell process before
Node starts; the bootstrap then verifies package bytes and file identities.
Use this generated launcher as the installed entry point. Internal JavaScript
invocation does not establish the launcher's runtime or custody guarantees.
Keep the receipt and runtime while installations use them. Updates install to
a new directory. Uninstall uses the same four binding options and never removes
contexts or the independent runtime. The [Windows filesystem contract](../docs/design/cli-windows-filesystem.md)
names the custody and durability checks and required native evidence.

Creating a private Windows directory reserves that destination and its exact
`.obsync-create` companion. An interrupted creation leaves at most this one
empty companion. Retry verifies its ownership, ACLs and emptiness before
publishing it. A nonempty or unsafe companion refuses unchanged; if both paths
exist, both are preserved. Do not use the companion for unrelated files.

## Deferred export

App/server export and client export/open are deferred with #317. This package
contains no vault decryption code. `obsync export open` returns unsupported;
no recovery-phrase or plaintext-destination option is accepted.

## One local context, end to end

Create an explicit JSON input containing only nonsecret target metadata:

```json
{"name":"personal","origin":"https://example.invalid","expected_instance":null}
```

Run `context add --input @/absolute/context.json`. This returns `data.plan` and
does not create configuration. Save **that plan object** to a file, then run
`context apply --input @/absolute/plan.json --expect-digest DIGEST`, using the
returned digest. `context use personal` and `context remove personal` follow the
same plan/apply sequence. `context get personal` reads back through a fresh
process. Removal affects only the local association.
The apply schema describes logical parameters `plan` and `expect_digest`; the
CLI binds these to the file contents and the separate flag respectively. Do not
wrap the plan object in another `plan` property inside the input file.

Plans bind the exact configuration directory, complete prior state, revision and
five-minute lifetime. Changed, expired and cross-target plans refuse. An
identical unexpired apply returns the stored receipt without repeating the
effect. A context origin or expected fingerprint is not verified server identity;
every output keeps `verified_instance` null and `server_contacted` false.
Origins accept ASCII DNS labels, canonical dotted IPv4 or canonical bracketed
IPv6. Only host lettercase, explicit `:443` and one final `/` normalize when
creating a plan. Stored origins are canonical; alternate numeric IP spellings,
trailing DNS dots, escaped hosts, Unicode hosts and zero-padded ports refuse.

The default directory is `~/.obsync`; `--config-dir ABSOLUTE_DIRECTORY` selects
one exact alternative whose parent already exists. First use creates only
that private leaf and confirms its publication before changing context state.
No current-directory configuration, plugin state,
credential-store inventory or environment credential discovery is loaded.
Context inputs never accept credentials, recovery material or vault keys.

## Durability and platform boundary

The [pinned Node SQLite built-in](https://nodejs.org/docs/v26.10.0/api/sqlite.html)
holds one bounded JSON state row and its operation receipts in `contexts.db`.
Each mutation uses an immediate transaction, full synchronization and the
rollback journal. Extension loading is disabled; only the exact known schema is
accepted. Context state and its receipt commit together. Kernel transaction locks
replace application lock files, so killing a writer leaves no stale owner lock.
Node classifies this built-in API as release-candidate; no npm package is added.

POSIX persistence requires owned 0700 directories, owned 0600 regular files,
protected ancestors and no symbolic or hard links. On macOS, the approved
read-only directory ACL reader also refuses grants and ambiguous metadata.
The independently verified macOS runtime must sit below a protected 0700
ancestor, so another account cannot reach its executable through a file ACL. Checks cover SQLite's exact
sidecar paths too. The selected OS user and host administrator remain trusted;
these checks do not isolate another process running as that same user.

After an interrupted transaction, reads may require recovery. Doctor reports
`recovery_required` without changing the database or journal. The explicit
`context recover` command restores the last committed state and applies no new
context plan. Read back, then resume an unexpired original plan or create a fresh
one. Do not delete database/journal files to clear a failure.

Windows persistent writes and recovery require the installed launcher and its
explicit trust receipt. Native receipts, distribution and independently trusted
runtime acquisition remain required before advertising a platform capability.

## Output and budgets

JSON is the default: compact through a pipe, indented on a terminal. `--output
jsonl` emits one envelope per invocation; `--output human` renders inert text.
`--non-interactive` never prompts or opens a browser. List/search commands accept
`--limit 1..500` and an opaque `--cursor`; continuation is explicit.

Input is at most 16 KiB, output at most 64 KiB, stored state at most 128 KiB,
contexts at most 64 and unexpired operation receipts at most 64. Each database or
sidecar is bounded to 512 KiB. The SQLite lock wait is one second. The five-second
command deadline is checked before a new context effect and before output; an
OS filesystem call cannot itself be interrupted. No idle process runs.

Exit classes used here: 0 satisfied, 2 invalid input, 4 permission/confinement,
5 revision/conflict/expiry, 6 unsupported capability or missing context, 7 unresolved/deadline,
9 local service/I/O failure and 10 required explicit recovery. Errors have the
same JSON envelope and never echo raw input or underlying filesystem errors.

## Verification

`node cli/test.mjs` runs real CLI subprocesses and cleans its
temporary directories outside the repository. It exercises discovery, an entire
context lifecycle, exact-plan refusals, output parsing/pagination, protected
paths, concurrent writers and process death before/after commit. The crash test
requires actual uncommitted page spill and proves read-only doctor preserves it
before explicit recovery. Package checks cover launcher tampering, preloads,
installation/removal interruption and explicit refusal of deferred export. These checks do not substitute for native installation with an
independently acquired runtime, publisher provenance, cold-agent or performance
receipts. The initial passing-test floor is 13 on POSIX and 2 for the Windows source
smoke tests; skipped tests cannot satisfy the floor. Windows acceptance also
requires the ordinary-user journey through the installed public command.

`node cli/reference.mjs` emits the command reference from the same catalog used
by discovery. The future MCP adapter can import that catalog; no MCP transport
is implemented here.
