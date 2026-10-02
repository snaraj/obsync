# Windows persistence: remaining WP1 decision

The offline CLI candidate still refuses Windows context mutations, installation
and plaintext export. That refusal is a safe failure, not completion of WP1.
This assessment identifies the smallest remaining platform work. It does not
enable an untested adapter or expand the repository's native-code exception.

## What the existing OS can supply

Windows PowerShell 5.1 and its built-in .NET Framework can create a directory
with its private DACL in the creation call, using
[`Directory.CreateDirectory(path, DirectorySecurity)`](https://learn.microsoft.com/en-us/dotnet/api/system.io.directory.createdirectory?view=netframework-4.8.1).
Creating a broadly accessible directory and running `icacls` afterward leaves
an exposure window and is not acceptable. Existing paths must be checked, never
silently repaired or adopted by resetting their permissions.

The small adapter would require a local NTFS volume, exact drive-absolute paths,
no alternate data stream, device/UNC path, trailing space/dot or reparse point,
and a single link for each file. It must inspect every ancestor's owner and
applicable DACL entries: another user's write, delete-child, change-permissions
or take-ownership permission can defeat a private leaf. The selected user,
SYSTEM and host administrators remain trusted. Private children inherit only
that trust set, and creation is followed by independent owner/DACL readback.

The installed launcher must select the OS PowerShell executable by a literal
path established through `.NET Environment.SystemDirectory` in an explicitly
invoked trusted PowerShell installer. `PATH`, `SystemRoot` and CWD must not
choose executable code. The installation receipt binds that executable and the
fixed shipped helper. Inputs to the helper are closed, bounded data; there is
no command text, arbitrary DLL, command runner or script-path option.

Context transactions can keep the existing pinned `node:sqlite` implementation.
Its Windows VFS uses the platform flush and transaction locking mechanisms;
see [SQLite's atomic commit contract](https://www.sqlite.org/atomiccommit.html).
The SQLite state and operation receipt remain one fully synchronized transaction.
The Windows adapter must establish private custody before opening SQLite, check
its exact sidecar files, and preserve explicit recovery after a killed writer.
It must not translate a failed POSIX directory fsync into a successful flush.

## Publication is a separate primitive

Managed file streams expose
[`Flush(true)`](https://learn.microsoft.com/en-us/dotnet/api/system.io.filestream.flush?view=netframework-4.8.1),
which flushes intermediate file buffers. That is not a documented general
directory fsync. Microsoft's
[`FlushFileBuffers`](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-flushfilebuffers)
requires a writable file handle; volume-wide flushing requires administrator
privilege and is not a viable ordinary-client workaround.

An installer can avoid replacing directories: copy into a fresh private version
directory, flush each exact package member, then write and flush a completion
receipt last. Every launcher must reject a missing, partial or changed receipt
and independently verify every package member before executing Node. Existing
versions remain untouched. This makes an interrupted copy unable to launch;
it does not by itself establish that new directory entries survive power loss.
The missing durability guarantee must be resolved before reporting durable
installation completion. Rechecking the directory immediately is not proof of
that guarantee.

The shared plaintext exporter additionally needs atomic publication of a
complete directory to a previously absent exact destination. Managed
[`Directory.Move`](https://learn.microsoft.com/en-us/dotnet/api/system.io.directory.move?view=netframework-4.8.1)
has no write-through option. The native
[`MoveFileExW`](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-movefileexw)
surface has `MOVEFILE_WRITE_THROUGH`; the candidate must remain on one volume,
exclude replacement/copy flags, and prove its directory behavior and recovery
on the supported native filesystem. This cannot be implemented by suppressing
the shared export adapter's current platform refusal.

## Bounded choices requiring review

1. **Keep only managed OS calls.** Implement DACL creation/inspection and retain
   SQLite transactions. Prove the immutable-directory installer with a receipt
   written last against a documented Windows durability contract. Plaintext
   export publication remains an unresolved WP1 capability. A green refusal test
   does not close either missing guarantee.
2. **Authorize a narrow native filesystem helper.** Preserve the Node built-ins
   and zero npm dependencies, but explicitly permit a reviewed OS interop file
   for the missing native directory publication/identity operations. A fixed
   PowerShell/.NET interop source would need the same package integrity checks
   and native acceptance as other shipped code. No generic FFI interface or
   dynamically chosen symbol/library belongs in the operation catalog.

The present AGENTS contract permits one FFI surface in the Rust server. The
approved Node runtime exception does not silently authorize another one.
Node 26.10.0 also exposes experimental
[`node:ffi`](https://nodejs.org/api/ffi.html), which its own documentation calls
unsafe; that is not a permission-free alternative. Shipping a new native helper
binary would add another build, artifact and provenance contract and is a larger
decision than the source helper above. No such exception or binary is added here.

## Required hosted Windows proof

Use a disposable hosted `windows-2025` runner and synthetic fixture paths only;
retain the exact package, Node and helper hashes with the result. The existing
CLI native workflow is prepared, but has not run for this candidate.

- Install the verified candidate as an ordinary user into a path containing
  spaces. Launch help/schema/context operations through a new terminal process.
  Clear preloads and inherited executable-selection inputs before Node starts.
- Read owner/DACLs through a separate OS process. A second disposable local
  account must fail to list/read/replace the private sentinel, database,
  sidecars, receipt and launcher; the intended account must succeed. DACL text
  alone is not an access-denial test. Remove only that fixture account afterward.
- Reject a junction/reparse point, hard link, network share, alternate data
  stream, insecure parent and a preexisting unknown destination without changing
  unrelated sentinels. The direct supported operation must still work.
- Kill actual installer/context processes before and after each publication
  boundary. A fresh process must find either the last committed state and its
  exact receipt or a named incomplete state; it must never accept partial code,
  duplicate a context mutation or need PID-only stale-lock deletion.
- For the shared exporter, independently read the completed plaintext and
  prove its ACL, exact destination and unchanged vault exclusions after restart.
  A killed publication must reconcile only its own bound journal and staging
  directory. Reuse the existing crypto/format modules.
- Record process-interruption evidence separately from power-loss durability.
  The latter requires an applicable documented native guarantee and, where it
  remains uncertain, a controlled VM power-loss/restart experiment. An ordinary
  runner process kill or clean volume unmount cannot stand in for that proof.
