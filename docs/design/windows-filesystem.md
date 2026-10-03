# Shared Windows filesystem candidate

The owner approved one client native import: `cli/windows-files.ps1` may call
`kernel32.dll!MoveFileExW` with fixed `MOVEFILE_WRITE_THROUGH` (`0x8`). On
2026-10-02 the owner also approved publication of a flushed, verified private
single-link regular file to an absent destination on the same NTFS volume.
No native symbol or flag was added. The
candidate remains unavailable through public export, context and installation
commands until native acceptance succeeds. Adding this source does not close
Windows support or authorize another interop surface.

## Exact boundary

The helper accepts one bounded, canonical JSON object on stdin with exactly
`v`, `op`, `path`, and `destination`. Operations are private inspection,
directory creation, empty-file creation, file flushing, an exclusive file lease,
and directory/file publication.
There are no credential bytes, command text, script path, DLL, symbol or flag
arguments. All refusals omit paths and native exception text. Inputs use local
fixed NTFS drives, canonical drive-absolute paths and no reparse points, device
names, alternate streams or existing publication destination. Publication is
restricted to sibling paths and checks the complete bounded tree or regular
file. The Node adapter proves single-link file custody before and after the
native call; the helper reads each private DACL and flushes every file.

Private DACLs are supplied to the managed directory/file creation calls and
read back. Existing ACLs are checked, never repaired. Private leaves allow only
the selected user, SYSTEM and host administrators; the owner must be the
selected user. Ancestors also trust Windows Modules Installer for OS-owned
directories. Other principals may traverse/read ancestors and create sibling
directories, but may not write existing ancestors, delete children, change
permissions or take ownership. Creating a sibling alone cannot replace the
protected selected child; an occupied final name is always refused. The Node
adapter independently checks file identities and rejects multiply linked data
files. The OS executable can have component-store hard links.

The one native declaration is emitted in memory using .NET's documented
[DefinePInvokeMethod](https://learn.microsoft.com/en-us/dotnet/api/system.reflection.emit.modulebuilder.definepinvokemethod?view=netframework-4.8.1).
Its DLL, symbol, signature, Unicode/ExactSpelling/SetLastError attributes and
publication flag are literals. This needs no compiler subprocess, temporary
assembly, saved native binary or generic FFI endpoint.

Each file is flushed with managed `FileStream.Flush(true)` before publication.
Microsoft documents the same-volume directory operation in
[Moving Directories](https://learn.microsoft.com/en-us/windows/win32/fileio/moving-directories)
and the flag in
[MoveFileExW](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-movefileexw).
The directory example uses the same flag for an absent destination on the same
drive. Together with explicit file flushing, this supplies the documented
API-level durable publication primitive. Native readback and actual process
interruption exercise its use. No physical power-loss experiment has been run;
that limits the evidence without adding a new prerequisite to this contract.

An operation lease holds a private empty file with managed `FileShare.None`.
The helper releases its kernel handle when the parent closes or loses its
stdin pipe. Both sides enforce a 30-minute bound, and cancellation terminates
only the exact owned helper. Recovery acquires this lease; it never deletes a
lock based on a process ID. The lease adds no native symbol.

## Packaging and bootstrap

`plugin/windows-helper.mjs` reads the one authoritative source, enforces its
size/encoding budget and emits its exact text and SHA-256. The plugin bundler
embeds that module inside `main.js`; the plugin release still has three assets.
The adapter compresses only that fixed, hash-checked source using Node and .NET
built-ins to fit Windows' command-line bound. Request values remain JSON data;
no request, environment value or filesystem script supplies executable code.
The CLI package must include the same source and generated shared module when
its predecessor is composed. Neither application depends on an installed CLI.

The adapter requires an OS PowerShell 5.1 absolute path and executable digest
established by explicitly invoked trusted OS setup. `PATH`, CWD, `SystemRoot`
and inherited preloads cannot choose that executable. The fixed source and
executable bytes are checked before every invocation, and the helper checks its
actual executable against `.NET Environment.SystemDirectory` and its OS ACLs.
The child receives only its validated OS root and the fixed OS PowerShell
module directory derived from it; module discovery cannot use an inherited path.
The one-time trusted bootstrap UI/receipt is still an integration requirement;
self-inspection after executing an ambiently chosen binary would not solve it.

## Evidence still required

The `windows-files` job in `.github/workflows/desktop-matrix.yml` builds the actual plugin and runs
`scripts/ci/windows-files-native.ps1` on a disposable hosted Windows runner.
It uses the real shared adapter, private synthetic fixtures, a temporary
ordinary second account, hard links, junctions, collisions and a fresh process
for publication. When the CLI source is present, it builds and exercises that
candidate in the same job. It verifies identity, sentinel bytes, and actual denial of
listing, reading and replacement. The driver removes only its own account and
exact fixture. The [preparation evidence](../validation-runs/2026-10-02-windows-native-preparation.md)
records passing ordinary-user custody, 7,703-file publication, killed-writer
recovery, and actual installer interruption at stage, receipt and publication
boundaries followed by fresh recovery, launch and uninstall.

Before enabling Windows, the implementation still needs these complete flows
and receipts:

- A trusted PowerShell bootstrap and protected receipt usable by the plugin
  without a CLI installation, plus CLI custody of that same trust information.
- Independent custody denial for every credential-bearing entry, extending
  the already passing second-account sentinel control.
- Shared export operation journals bound to exact stage/target identities,
  crash reconciliation, vault exclusions and plaintext ACL readback.
- Native operation-lease exclusion and recovery through the shared export
  transaction, including parent-process interruption and fresh reconciliation.

Until these pass, the product's Windows refusals remain in place. This is a
reviewable source layer and native proof preparation, not a Windows release.
