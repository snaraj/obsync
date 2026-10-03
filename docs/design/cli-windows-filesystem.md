# Native CLI private storage on Windows

The Rust CLI embeds one fixed PowerShell 5.1 helper. It accepts only closed JSON
requests over stdin; request values never become code. The owner-approved native
surfaces are `MoveFileExW` with `WRITE_THROUGH` for absent sibling publication,
and Rust's read-only `GetFileInformationByHandle` on an already-open file.

## Trusted OS setup

The public `windows-setup` command prints a fixed script. The operator runs it in
an independently opened OS PowerShell 5.1 session after publisher verification.
That script creates a private receipt binding the OS executable's absolute path
and SHA-256. The operator retains the receipt path and digest independently.
Storage operations require both. No PATH lookup or ambient receipt import occurs.

Rust holds the verified executable without write/delete sharing while the helper
runs. It clears the environment, passes fixed source as one bounded `-Command`
argument and sends the separate JSON request through stdin. Helper output and
execution time are bounded. The fixed source checks its own OS executable,
PowerShell version and built-in module custody before processing a request.

## Filesystem contract

Only local NTFS paths with canonical spelling are accepted. Reparse points,
unknown entries and hardlinked files refuse. Owners and DACLs are inspected on
ancestors and leaves. Private leaves grant access only to the selected user,
SYSTEM and administrators. The selected user and host administrator remain
trusted; this is not isolation from another process with the same identity.

New files and directories start private. Publication flushes the private tree
and uses the approved absent-destination, same-volume move. No overwrite, copy
fallback or reboot scheduling is allowed. Interrupted creation companions have
fixed names and must be empty, private and independently inspected before reuse.

Context storage uses two bounded snapshots and Rust's OS file locks. Each
snapshot includes the state and its receipts. Full-length checksum or schema
corruption refuses recovery; an incomplete inactive slot can be discarded only
through explicit recovery. Installation publishes a complete private directory
and verifies its inventory. Uninstall inspects every remaining member before
removal. The permanent target lock stores a flushed target/manifest binding;
it survives cleanup so reordered deletions remain identifiable on retry.
Source and destination ancestry is compared by opened filesystem identity,
including case and short-name aliases.

Windows uninstall durably retires the installation path with the approved
write-through move. Cleanup reports observed absence and `cleanup_durable: false`:
directory deletions are not proven durable across power loss. The exact uninstall
can remove matching retired files that reappear. Run it from the original verified
package, since Windows cannot flush an executable that is currently running.

## Acceptance

The hosted Windows job creates two disposable ordinary accounts. One runs the
public setup and packaged CLI journey; the other must fail directory enumeration,
file reading and writing against the private fixture. The journey independently
reads context snapshots and receipts and checks install/uninstall inventories.
All temporary accounts, profiles and synthetic fixture directories are removed.

Native Windows runtime, interrupted creation/publication/recovery, DACL/reparse
refusals, meaningful mutation tests and visible manual terminal validation must
pass before release. Cross-compilation and source review are insufficient.
No physical power-loss claim follows from a process-kill test.
