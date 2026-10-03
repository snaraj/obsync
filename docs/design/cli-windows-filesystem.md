# Windows CLI persistence

The CLI uses `cli/windows-files.ps1`, whose sole native import is
`kernel32.dll!MoveFileExW` with fixed `MOVEFILE_WRITE_THROUGH`. It publishes
an owned private directory or single-link file to an absent sibling on the
same local NTFS volume. There is no replacement, copy fallback, reboot
scheduling, additional native binary or arbitrary DLL/symbol selection.
Export is deferred with #317; no vault decryption code is packaged.

## Installation and trust

An ordinary selected user runs explicit setup in trusted OS PowerShell 5.1.
The resulting private receipt binds that executable and its SHA-256. The
public installer requires its exact path and digest; it never discovers an
executable through PATH or imports an ambient receipt. Node 26.10.0 and its
libraries are an independently trusted prerequisite. See the
[installation instructions](https://github.com/snaraj/obsync/blob/main/cli/README.md).

`install-windows.mjs` verifies the exact package, private runtime and receipt.
It writes a fresh private sibling, verifies every member, writes its completion
receipt last and publishes to an absent prefix. Interrupted copies resume only
where existing bytes match the same package. Existing installations cannot be
overwritten or retargeted. Upgrade selects a separately verified directory.

The launcher uses the bound OS PowerShell path with module autoload disabled.
It embeds the same fixed read-only custody functions as the filesystem helper,
so installation and trust ancestry, ownership and ACLs are checked in that
process. It verifies the OS shell hash, receipt, trust record, runtime and bootstrap before starting
Node with a cleared environment. The bootstrap checks every package member
and retains its Node file identity/link checks before importing commands.
Later context I/O still performs native custody checks. Missing or changed
bytes refuse execution. The generated launcher is the supported entry point;
internal JavaScript invocation does not establish its runtime or custody guarantees.
Uninstall disables the exact installation by publishing its removal sibling,
checks every remaining member, and deletes its receipt last. It preserves
configuration and unrelated files.

## Local state

`Contexts` establishes private custody before opening SQLite and inspects the
existing database and rollback journal. Each effect and its receipt commit in
one fully synchronized transaction. Kernel locks release on process death;
recovery never deletes a lock based only on a PID. `doctor` remains read-only,
and `context recover` restores only previously committed state.

The helper reads actual ownership, ACLs and ancestors, refuses reparse points
and ambiguous path spellings, flushes every source file, and verifies identity
after publication. Selected-user and administrator processes remain trusted.
The CLI stores only nonsecret target metadata; credential custody belongs to
the later authenticated slice.

Directory creation reserves the selected destination and its exact
`.obsync-create` companion. It publishes an empty private companion with
write-through semantics. Retry reuses only an owned, private, empty ordinary
directory with safe ancestry. This reserved-path binding does not prove who
originally created the empty directory. Nonempty or unsafe companions refuse
unchanged; an existing destination preserves both paths. No pattern cleanup
or recursive removal is involved.

## Native acceptance

`cli-native.yml` runs on disposable Windows, macOS and both Linux architectures.
The Windows controller creates two ordinary local users and exact synthetic
profiles. The second account must fail to list, read or replace the first
account's private sentinel. Cleanup removes the fixture accounts and profiles.

The actual Windows journey covers private publication, identity readback,
SQLite writer death and recovery, and installer interruption at private-stage,
completion-receipt and publication boundaries. Recovery invokes the public
installer in the killed process itself. The installed command then plans,
applies, replays and independently reads a context; doctor and capabilities
must agree with the resulting state. Removal uses the public installer.
Directory-creation interruption kills the actual helper before publication,
inventories the sole reserved companion before cleanup, and verifies that retry
preserves its identity. A nonempty companion collision preserves its sentinel.

Native process interruption proves only the exercised boundaries. SQLite's
[atomic commit contract](https://www.sqlite.org/atomiccommit.html), managed
[`Flush(true)`](https://learn.microsoft.com/en-us/dotnet/api/system.io.filestream.flush?view=netframework-4.8.1)
and same-volume write-through publication define the durability mechanism;
physical power-loss behavior requires separate evidence. A private copy of a
CI-provided Node executable proves custody, not public runtime acquisition.
Publisher provenance and startup performance remain independent gates.
