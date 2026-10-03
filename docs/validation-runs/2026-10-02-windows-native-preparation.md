# Windows native preparation — 2026-10-02

This is a source preparation branch, with no release or version claim.

## Real Obsidian journey

[Hosted run 37074994057](https://github.com/snaraj/obsync/actions/runs/37074994057)
passed at source `4384669dbd642bdb075a6af886e323b736e15e53` on Windows Server
2025, using Obsidian 1.13.7 and Electron 43.3.0. The tested plugin `main.js`
SHA-256 was `1e1a7b78ac8f12d329aeb75dc2df2de434d3082829954be411aee4276f0f50a1`.
The server was built from the same source and ran in the disposable WSL 1
fixture behind the existing loopback TLS harness.

The existing real-app harness passed all 13 steps in 119.4 seconds:

- Setup and pairing through the plugin settings and dialogs.
- Notes in both directions, rename, nested and empty folders.
- Ten edits reached the other disk: p50 1024 ms, p95/max 1032 ms.
- Both open editors received 99 keystrokes each over 20.076 seconds. Every
  token was in both editors and both disks 10.430 seconds after typing stopped,
  with no conflict copy.
- Watcher-independent listing, edits, rename and deletion reconciled.
- NTFS case-only rename, trash propagation and locked-file recovery passed.
  The locked edit arrived after release of the deliberately held file.
- The workflow's owned-fixture cleanup completed.

These are functional measurements on a hosted runner. They are not a quiet
latency comparison, a claim of acceptable interactive latency, or visual
approval from screenshots. Later source changes need their own evidence.

## Filesystem custody and installer

[Hosted run 37082836587](https://github.com/snaraj/obsync/actions/runs/37082836587)
passed at signed source `344458403fbc7ef66771f0f8bf1e2dc3be9babd7` on the
`windows-2025` runner. GitHub verified that commit's signature. The job took
2 minutes 44 seconds and finished at 00:40 UTC on 2026-10-03. The candidate
used exactly Node 26.10.0 and the helper required OS PowerShell 5.1.

The built CLI package had 28 members and manifest SHA-256
`9a081bb3e04056a5e6f1556b66279b56f972f9bb1df846b21456019d2330a58c`.
It was an unversioned preparation candidate; its existing VERSION output is
not a CLI release or public artifact claim. The authoritative helper SHA-256
was `103371590e111fdc313732b9e0035fe7bd8d651294c0cf6b43678fe8d4d0d1a4`.

The actual ordinary-user journey passed:

- Explicit OS setup and protected receipt import.
- Private creation and inherited-entry owner/DACL readback, with path,
  hard-link, junction and occupied-destination refusals.
- A second ordinary account's independent list, read and replacement attempts;
  each received an actual access-denied exception.
- Fresh-process directory and regular-file publication. Both kept their exact
  identity and bytes; collision and multiply-linked sources refused.
- A held SQLite database refused the helper's exclusive flush; closing the
  database allowed that same flush. Context commit and receipt replay passed.
- An actual writer was killed with an uncommitted update. A fresh process
  recovered the last committed state without applying the update again.
- Immutable package installation, a new native PowerShell launcher process,
  verified offline version output, and exact uninstall.
- Removal of the exact synthetic fixture and the two disposable accounts and
  profiles. No owner vault, account or machine configuration was used.

The fixture's private copy of setup-node's executable proves runtime custody
for that journey. It is not proof of a public trusted-runtime acquisition path.

### Failures retained

These failures led to changes in the actual process path; a local unit-test
pass did not establish Windows operation:

| Evidence | Failure and correction |
| --- | --- |
| [37076116149](https://github.com/snaraj/obsync/actions/runs/37076116149) | The .NET Framework stdin writer prefixed UTF-8 JSON with a BOM. The bootstrap now chooses BOM-free encoding before constructing the owned pipe. |
| [37077937244](https://github.com/snaraj/obsync/actions/runs/37077937244) | JSON module autoload stalled with the cleared environment. The helper verifies and explicitly imports the fixed OS utility module, with autoload disabled. |
| [37078393911](https://github.com/snaraj/obsync/actions/runs/37078393911) | An elevated-token fixture hit the exact-user owner guard. Product operations now run as an ordinary user; the ownership guard remains unchanged. |
| [37079494981](https://github.com/snaraj/obsync/actions/runs/37079494981), [37079933876](https://github.com/snaraj/obsync/actions/runs/37079933876) | Credentialed children needed explicit hosted markers and fixed `.EXE` classification in their cleared environment. No inherited PATH or preloads were restored. |
| [37081288955](https://github.com/snaraj/obsync/actions/runs/37081288955) | The encoded peer probe exceeded the credentialed Windows command-line limit. The fixed checked-in peer phase now uses a short file invocation with an explicit bound. |
| [37081564717](https://github.com/snaraj/obsync/actions/runs/37081564717) | SQLite still held the database open when the helper requested exclusive access after commit. The committed handle now closes before the independent flush. |
| [37082076460](https://github.com/snaraj/obsync/actions/runs/37082076460) | The generated launcher function `H` collided with PowerShell's built-in history alias. Descriptive function names and corrected argument escaping passed the fresh launcher journey. |

### Remaining gates

Public Windows export, context mutation and installation remain unavailable.
The passing internal journey does not establish the plugin's trusted bootstrap
UI, shared export journal and crash reconciliation, interrupted installer
boundaries, the 7,703-file publication budget, or power-loss durability.
Those need their own complete native proof. The live sync journey also remains
separate from private export and installation evidence. No release, production
installation or acceptable-latency claim is made here.
