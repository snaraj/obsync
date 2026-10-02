# Offline management client candidate

This unversioned source slice is not a published CLI. It implements local
discovery, context management, a read-only doctor and shared offline export
opening. Authentication, native setup, server operations and MCP return explicit
unsupported results. Publication and native installation evidence remain gates.

## Run from an explicitly trusted checkout

Use Node **26.10.0**, with no runtime packages:

```sh
node cli/obsync.mjs --help
node cli/obsync.mjs cli search context
node cli/obsync.mjs schema context.add
node cli/obsync.mjs capabilities
node cli/obsync.mjs doctor
```

The source entry refuses runtime options/preloads it can observe. This check
cannot undo code Node already loaded. A released launcher must select a verified
runtime and clear unsupported runtime inputs before execution; source invocation
does not establish that guarantee. The package includes that launcher and an
immutable-directory installer. Its native installation claims remain gated below.

## Build and install

`node cli/build.mjs` compiles the existing plugin export modules with the pinned
TypeScript compiler and writes one closed package to `cli/dist`. The source
checkout needs the plugin's build dependency installed first. No additional
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
all package hashes before loading CLI code. The OS, its loader, the selected user
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

Windows installation currently refuses before writing. The hosted native jobs
prove either the implemented operation or this explicit refusal; they do not
establish Windows credential ACL support.

## Open an encrypted export offline

Use the complete verified package. Select the source vault root for destination
exclusion, one archive and a new private destination. `--plaintext` acknowledges
the output. Supply recovery words through inherited descriptor 3–999 using a
protected pipe or owned 0600 regular file; never put them in arguments,
environment variables, context JSON or logs. Example for an already protected
file named by `$phrase_file`:

```sh
"$new_install_directory/obsync" export open \
  --archive "$encrypted_archive" --destination "$new_plaintext_directory" \
  --vault-root "$source_vault" --phrase-fd 3 --plaintext 3<"$phrase_file"
```

The phrase channel is limited to 1024 bytes; a pipe must close within five
seconds. Phrase/key buffers are cleared where possible; managed strings cannot
promise physical erasure. `--allow-server-origin` separately acknowledges that a
server archive's inventory lacks a device authenticator. The shared opener still
authenticates ciphertext and paths, applies its filesystem policy and publishes
only a complete result. It refuses Windows and destinations inside the selected
vault or a standard `.obsidian` vault. Detecting another vault's nonstandard
configuration directory remains a native API gap. No network request is made.

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
one exact alternative. No current-directory configuration, plugin state,
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
protected ancestors and no symbolic or hard links. Checks cover SQLite's exact
sidecar paths too. The selected OS user and host administrator remain trusted;
these checks do not isolate another process running as that same user.

After an interrupted transaction, reads may require recovery. Doctor reports
`recovery_required` without changing the database or journal. The explicit
`context recover` command restores the last committed state and applies no new
context plan. Read back, then resume an unexpired original plan or create a fresh
one. Do not delete database/journal files to clear a failure.

Persistent writes and recovery are currently limited to macOS/Linux. Windows
can read nonsecret metadata but has no advertised ACL or write-durability
guarantee. Native Windows/Linux receipts, distribution and installation are
still required before advertising those shipping capabilities.

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
Offline export uses the shared 30-minute budget and emits static structured
progress while processing. Its file count and byte count reveal no clear names.

Exit classes used here: 0 satisfied, 2 invalid input, 4 permission/confinement,
5 revision/conflict/expiry, 6 unsupported capability, 7 unresolved/deadline,
9 local service/I/O failure and 10 required explicit recovery. Errors have the
same JSON envelope and never echo raw input or underlying filesystem errors.

## Verification

`node cli/test.mjs` runs real CLI subprocesses and cleans its
temporary directories outside the repository. It exercises discovery, an entire
context lifecycle, exact-plan refusals, output parsing/pagination, protected
paths, concurrent writers and process death before/after commit. The crash test
requires actual uncommitted page spill and proves read-only doctor preserves it
before explicit recovery. Package checks cover launcher tampering, preloads,
installation/removal interruption and device export → CLI → independent file
readback. These checks do not substitute for native installation with an
independently acquired runtime, publisher provenance, cold-agent or performance
receipts. The initial passing-test floor is 12 on POSIX and 2 on Windows, where
persistence is explicitly unavailable; skipped tests cannot satisfy the floor.

`node cli/reference.mjs` emits the command reference from the same catalog used
by discovery. The future MCP adapter can import that catalog; no MCP transport
is implemented here.
