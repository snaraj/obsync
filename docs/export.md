# Export and offline copies

An export is a copy of selected notes, not a server backup. Keep the source
and the recovery phrase until the opened copy has been checked. The archive
contains encrypted manifests and chunks. It reveals opaque identifiers,
version relationships, counts and sizes; names and content stay encrypted.
The phrase and vault key never go to the server.

## Use

On macOS or Linux, run **obsync: Export or open a copy** from Obsidian's
command palette, or choose the export action in obsync settings.

- **Export encrypted copy** downloads the server's ciphertext. It includes
  every current head, including conflicts. Enable **Include retained
  history** to add older retained versions. Unuploaded local edits are absent.
- **Open an export offline** needs the archive and this device's vault key,
  or the recovery phrase entered in its password field. It makes no network
  request. Confirm that the new folder will contain unencrypted notes.
- **Export local plain notes** copies visible on-disk files, including files
  outside the sync selection. It excludes hidden state and the active vault's
  configured settings directory (including non-dot names), refuses links and
  nested vaults, and lists known pending uploads/downloads. Unsaved editor
  text and unknown server changes are not part of this local snapshot.

Use an absolute destination outside every vault; it must not exist. The
adapter refuses the open vault by directory identity (including case aliases)
and ancestors containing a standard `.obsidian` directory. It cannot discover another vault using a custom configuration
directory, so that destination exclusion remains an acceptance gap. Existing
files are never overwritten. A normal failure removes that attempt's stage
only while its destination boundary remains unchanged.

For an offline server copy, stop the server and use a dedicated restored
copy of its volumes, preserving the pristine backup:

```sh
obsyncd export --domain <32-hex-domain-id> --out /absolute/new-copy.obsync
```

Add `--history` for all retained versions. `--key` and `--key-file` are
unknown arguments: the server never asks for content keys or decrypts notes.
Opening storage performs the same posture and recovery operations as
[`obsyncd check`](storage.md#offline-check-and-recovery-verdicts). The server
holds the exclusive store lock throughout selection and copying. Any missing
chunk is reported by its ciphertext identifier and prevents publication.

For a server-made archive, the app additionally requires **This copy came
from the server**. Its selected content is authenticated during decryption,
but no device authenticated which files or versions were included. An empty
server-made archive cannot demonstrate possession of the correct key and is
refused. A server archive is not proof of completeness or freshness.

## Format 1

All integer framing is unsigned big-endian. Lengths count bytes.

| Order | Bytes |
| --- | --- |
| Magic | UTF-8 `OBSYNC-EXPORT-1` followed by one newline |
| Inventory length | 4-byte length `N` |
| Inventory | `N` bytes of UTF-8 JSON |
| Inventory digest | SHA-256 of those exact `N` bytes, 32 bytes |
| Device authenticator | 32 bytes, described below |
| Chunks | Repeated 4-byte ciphertext length followed by that ciphertext |

The inventory has `v: 1`, `source: "device" | "server"`,
`scope: "current" | "history"`, integer `snapshot`, and `files`.
Each file contains `file_id`, `domain_id`, every current `head` in `heads`,
and the selected `versions`. A version carries the protocol's `version_id`,
`parents`, ordered `sids`, `bytes`, base64 `manifest_ct`, hex
`manifest_nonce`, and `deleted`. Identifier lengths and version hashes are
the existing [wire contract](protocol.md#files-and-versions).

Chunks occur once each, ordered by their lowercase hexadecimal SID. The
reader derives this exact list from the selected versions; there are no
archive filenames, link entries or implicit trailing records. Every SID is
verified against SHA-256 of the ciphertext. Missing, short, extra or changed
bytes refuse the copy.

For `source: "device"`, derive a 32-byte key with HKDF-SHA256 using the vault
root key as input, UTF-8 `obsync/export/v1/inventory` as salt, and empty info.
The authenticator is HMAC-SHA256 of the 32-byte inventory digest. This binds
the exact selection and its referenced ciphertext identifiers to a device
holding the vault key. It does not independently prove that the server
revealed every file or its latest version. For `source: "server"`, the
authenticator is exactly 32 zero bytes, with the explicit acknowledgment
above. The digest by itself is not authentication.

A device selects from a bounded change-feed walk. Each page and a final
head check must report the same journal head. A concurrent change refuses
the attempt; the exporter never silently retries into a different snapshot.
Current scope must include every head and no non-head version. History
scope includes all retained versions returned by that coherent walk. A
missing head refuses either scope. The offline server uses its store lock
instead of this feed check and selects only the requested domain.

Opening reuses the plugin's WebCrypto and manifest validators. It verifies
version hashes, manifest GCM tags and record bindings, each chunk's GCM tag
and keyed content identifier, and single-chunk plaintext hashes. The
lexicographically first current head uses its original path. Additional
heads go under `obsync-conflicts/<file-id>/<version-id>/`; non-head history
goes under `obsync-history/<file-id>/<version-id>/`. Tombstones and pause
controls write no file. Directory records retain empty folders. Reserved
paths, traversal, symlinks, file/directory clashes and case or Unicode NFC
collisions refuse the whole operation; no collision is resolved by overwrite.

## Bounds and publication

Device operations allow at most 100,000 selected versions, 64 MiB of raw
inventory, one million chunk references, 64 GiB of archive/output and
30 minutes of work. A feed walk visits at most one million records. Chunks
are at most 8 MiB plus the 16-byte tag, read and decrypted one at a time.
Metadata is retained in memory; chunk content is never accumulated for a
whole vault or whole file. These are device resource policies. The server
streams chunks in 64 KiB buffers and bounds its inventory to 64 MiB; a
server archive beyond the device policy is refused by the current opener.

Before writing, the desktop adapter checks at most 128 destination ancestors, available
space with a 64 MiB reserve, path collisions and archive metadata. A wrong
phrase creates no stage. Plaintext goes to a random sibling stage, with
0700 directories and 0600 files. Every chunk authenticates before its bytes
are written. Files and directories are flushed before the verified tree is
renamed over an exclusively reserved empty destination; the parent is then
flushed. Encrypted archives use an exclusive hard-link publication after
the file flush. Neither route replaces an existing destination.

Every output ancestor must be owned by the current OS user or root. Group or
other write access requires a sticky directory; each child must in turn have
a trusted owner. Directory identity, ownership and mode are rechecked around
staging, publication and cleanup. A changed boundary refuses further writes
or cleanup and preserves the recorded stage for inspection. These checks
depend on local POSIX ownership, sticky-directory and atomic-rename semantics.
Remote, FUSE and other filesystems without those semantics are unsupported;
the current adapter does not yet prove the backing filesystem's capability.
On Linux, a POSIX access ACL's mask is represented by the group mode bits.
Filesystems with other ACL semantics need a separate capability check.

**macOS ACL assurance is blocked.** POSIX mode bits do not bound all macOS
ACL grants. A successful `/bin/ls -e` cannot establish absence: Apple's
[`ls` source](https://github.com/apple-oss-distributions/file_cmds/blob/main/ls/ls.c)
does not report every ACL retrieval failure, and its
[`ACL printer`](https://github.com/apple-oss-distributions/file_cmds/blob/main/ls/print.c)
can skip entries whose fields fail to read. No output parser, permission
repair or allow-ACL fallback is used. An error-reporting native reader and
an explicit interoperability decision are still required before claiming
private output on macOS. The existing functional journey does not resolve
this blocker.

A caught failure or cancellation before publication removes the owned
stage if the destination boundary remains unchanged. Each destination has a
mode-0600, flushed recovery journal that binds
its process ID, stage identity and reserved destination identity. Retrying
the same destination first verifies that the old process is absent, then
removes only that recorded stage and an unchanged empty reservation. A live
process, untrusted journal or mismatched identity causes a refusal. Recovery
never sweeps similarly named directories. A crash before the initial stage
identity is recorded can leave an empty stage or incomplete journal that
requires inspection; it is not removed based on its name alone. A crash
during a journal update can leave a private metadata temporary file.
No partial plaintext tree is published. Deletion is not secure erasure.
A crash after publication may leave a
complete verified output. A parent-flush failure is reported as uncertain
durability, so keep the source and check the output before relying on it.
Concurrent modification by another process running as the same OS user is
outside this filesystem trust boundary.
The local plain copy detects identity, size and modification-time changes
during its scan/copy/scan window. It is not an atomic filesystem snapshot;
same-size writes that restore the original modification time are not proven
absent. Quiescent native validation must check the copied bytes independently.

## Platform and acceptance status

| Platform | Current behavior | Native acceptance |
| --- | --- | --- |
| macOS desktop | Functional export/open/copy implemented; ACL assurance blocked | Native three-file journey passed before the ancestor delta; [record](validation-runs/2026-10-02-export-desktop.md) lists limits |
| Linux desktop | Same implementation and POSIX publication requirements | NOT_RUN |
| Windows desktop | Refuses before filesystem access; private ACL and directory publication need a supported implementation | NOT_RUN |
| Android / iOS | Refuses export before filesystem access; no internal-vault fallback | NOT_RUN on emulator or physical phone |
| Offline client CLI | Shared format and crypto modules available; command integration belongs to #255 | NOT_RUN |

The checked public Obsidian `DataAdapter` API is vault-relative. It has no
external-folder picker, private staging, flush or external publication
contract. [Obsidian's mobile documentation](https://docs.obsidian.md/Plugins/Getting%20started/Mobile%20development)
also excludes Node and Electron APIs there. This does not establish that no
native mobile facility exists; a supported native adapter and real device
proof remain required. [Node's Windows permission limitation](https://nodejs.org/api/fs.html#fschmodpath-mode-callback)
means POSIX modes alone do not establish an owner-only export on Windows.

Two implementation routes were checked without adding platform promises:

- [Web Share](https://www.w3.org/TR/web-share/) accepts files for a chosen
  share target. It does not supply an external-folder staging, durable
  publication or read-back contract. It could be a candidate for encrypted
  file sharing, but does not complete the plain-folder requirement.
- Windows provides native ACL APIs and
  [MoveFileExW](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-movefileexw)
  with a write-through option; directory moves stay on one drive. A supported
  adapter must establish private ACLs before writing and prove durable
  publication. Node's current mode/rename surface does not supply that proof;
  adding native bindings or a helper needs an explicit dependency decision
  and Windows acceptance evidence.

Issue #317 remains open until app/CLI interoperability, physical phone and
desktop journeys, crash recovery, and the 7,703-note elapsed-time, peak-memory,
extra-disk and UI-responsiveness measurements are recorded with integrity
checks enabled. Tests use generated sentinel notes and remove their files;
reusable lab vaults and run artifacts belong outside the repository.
