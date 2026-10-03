# Windows CLI persistence candidate

The source candidate uses the [shared Windows filesystem helper](windows-filesystem.md).
The owner approved its one fixed `MoveFileExW` import for absent-destination
publication of an owned directory or a private single-link regular file on the
same NTFS volume. There is no additional native binary, symbol or dependency.
Public Windows context mutations, installation and export remain unavailable
until the complete native journeys and durability contract pass review.

## Implemented source paths

- `Contexts` accepts the shared adapter internally. It establishes private
  directory custody before opening SQLite and inspects existing database and
  rollback-journal entries. Context state and operation receipts use one fully
  synchronized SQLite transaction. Kernel transaction locks release on process
  death; recovery never deletes a lock based only on a PID.
- `install-windows.mjs` verifies the exact package, pinned runtime and explicit
  trust receipt. It writes a fresh immutable sibling, verifies each member,
  writes its completion receipt last and publishes to an absent prefix.
  Interrupted copies can resume only where each existing byte matches the
  same package. Existing installations cannot be overwritten or retargeted.
- The generated launcher uses the bound OS PowerShell path and managed SHA-256
  with module autoload disabled. It verifies its receipt, runtime and bootstrap
  before starting Node with a cleared environment. The bootstrap checks every
  package member before importing commands. A missing or changed completion
  receipt refuses execution.
- Uninstall binds the exact prefix, package and receipt, moves to its owned
  removal sibling, and checks remaining member bytes before removal. It keeps
  the receipt until the package members have been removed.

These are internal candidate paths, not advertised Windows capabilities.
The trusted setup UI and shared export recovery journal remain integration
requirements. The plugin embeds the same helper source in `main.js` and must
not acquire an installed-CLI prerequisite.

## Native acceptance

The existing `desktop-matrix.yml` workflow has a `windows-files` dispatch.
It builds the actual plugin and CLI candidate, then runs product operations as
an ordinary disposable local user. A second ordinary account independently
attempts to list, read and replace a private sentinel. The controller creates
and removes only those accounts and their exact synthetic fixture profiles.
No owner account, vault, address or local-machine configuration is involved.

The journey covers path, reparse point, hard-link and collision refusals;
fresh-process directory/file publication and identity readback; a real killed
SQLite writer and fresh recovery; immutable installation, fresh native launch
and exact uninstall. The fixture's private copy of the pinned setup-node
executable tests custody only. It does not establish public runtime acquisition
or release provenance. Native failures and remaining gaps are recorded in the
[preparation evidence](../validation-runs/2026-10-02-windows-native-preparation.md).

Before enabling Windows, also prove interrupted installation at each completion
boundary, denial of access to all credential-bearing entries, and the full
shared export journey with exact journal recovery and vault exclusions. The
app's bootstrap must be usable without a CLI installation. Receipt validation
must precede using its executable path.

SQLite documents its [atomic commit contract](https://www.sqlite.org/atomiccommit.html).
Managed [`Flush(true)`](https://learn.microsoft.com/en-us/dotnet/api/system.io.filestream.flush?view=netframework-4.8.1)
is a file flush, not a general directory fsync. Process interruption is also
not a power-loss experiment. Publication needs an applicable documented native
durability guarantee and, if that remains uncertain, controlled native VM
power-loss/restart evidence. A green refusal or ordinary process kill does not
close that gate.
