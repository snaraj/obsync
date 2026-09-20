# Plugin settings

Every field in Settings → Community plugins → Self Hosted Private Sync, what
it defaults to, and when it is worth changing. The fields are
`plugin/src/ui/settings.ts`; both ceilings default per platform from
`plugin/src/policy.ts`, this device's **Name** from `defaultDeviceName()` in
`plugin/src/main.ts`, and the rest from the field itself.

Everything here is **per device**. Nothing in this tab is synced, and no other
device can change it for you.

## Above the first heading

| Row | When it appears | What it does |
| --- | --- | --- |
| **Update available** | only when the server reports a newer plugin version than this device runs | one sentence naming both versions and sending you to Obsidian's own updater. Nothing here installs code: the plugin never fetches its own bundle from the sync server |

## Server

| Setting | Default | What it does | When to change it |
| --- | --- | --- | --- |
| **Server URL** | empty | The address this device sends every sync request to. HTTPS only on iOS and Android, and the port belongs in it when it is not 443 (`https://name:8443`). | Once at setup, and again if the server moves ([`recovery.md`](recovery.md)) |
| **Edge service-token headers** | empty | One `Name: value` per line, sent with every request. For a deployment with an access-controlled proxy in front of the server. | Only if your edge requires a service token. Leave empty otherwise |
| **Connection** → **Check** | — | Asks the server who it is and reports the account name and device count. | Any time you want one round trip to prove the address, the certificate and the credential together |
| **Connection** → **Open dashboard** | — | Mints a single-use sign-in link and opens the dashboard. The link is resolved against the Server URL above and opened only if it stays on that origin. | — |

## Sync folders on this device

| Setting | Default | What it does | When to change it |
| --- | --- | --- | --- |
| **Current selection** | — | Not a field: it reads back what this device has SAVED, which is what sync obeys. An edit below that has not been saved does not appear here | — |
| **Folder selection** | Whole vault | `Whole vault`, or `Selected folders only`. Hidden folders (`.obsidian`, `.git`) and symlinked folders are excluded either way. | Before the first sync, if the vault also holds code or private files |
| **Selected folders** | empty | One relative folder per line, no leading or trailing slash. An empty list with `Selected folders only` syncs nothing. | With the setting above |
| **Save on this device** | — | Waits for active transfers, then rescans. | After every change to the two above — nothing takes effect until this is pressed |

The selection can only NARROW once a device has synced. To sync more of this
vault, move the files into a folder that is already selected and run **Sync
now**. Removed folders keep their local files and their history on the server.

## This device

| Setting | Default | What it does | When to change it |
| --- | --- | --- | --- |
| **Pairing** → **Pair this device** | — | Opens the dialog that takes a pairing code from a device that already syncs. | On every device after the first |
| **Pairing** → **Pair a new device** | — | Mints a one-time code, valid ten minutes, for another device to claim. | When adding a device |
| **First-time setup** → setup token | — | The token the server wrote at first boot. Creates the account and enrolls this device. It is not spent: it stays the dashboard's recovery sign-in. | Once, on the first device |
| **First-time setup** → account name | `obsync` | What the dashboard calls this account. | Rarely; it is a label |
| **Name** | the platform and a short device id, e.g. `macos-1a2b` | How this device appears in the dashboard's device list and in another device's conflict copies. | Give each device a name you will recognise months later |
| **Largest file to download** | `0` (unlimited) on desktop, `512 MiB` on mobile | Files above it stay on the server and appear under **Show remote-only files**, to fetch on demand. | On a phone with room to spare, or one with none. `0` means unlimited |
| **Total to keep on this device** | `0` (unlimited) on desktop, `50 GiB` on mobile | Above this total, new files stay remote-only. | Same |
| **Save to server** | — | Sends the name and both ceilings together, so the dashboard shows what this device will actually hold. | After changing any of the three above |

Mobile ceilings exist because Obsidian on a phone reads and writes whole files
in memory: a ceiling is what keeps one large attachment from ending the app.
Desktop streams files in 8 MiB windows, which is why it has no practical
ceiling.

## Devices

The list of every device on the account, with **Revoke** beside each one.
Revocation destroys that device's wrapped secret on the server and is final —
a revoked device is paired again as a new device.

## Vault key

| Setting | What it does |
| --- | --- |
| **Recovery phrase** → **Show** | Re-displays the 24 words from this device's own key. Anyone holding them can read this vault |
| **Recovery phrase** → **Restore or create** | **Restore** adopts an existing vault key from its phrase. **Create a new vault key** starts a NEW vault that existing devices will not read — see [`recovery.md`](recovery.md) before pressing it |

## Commands, not settings

`Sync now`, `Show sync status`, `Pair a new device`, `Show recovery phrase`,
`Restore from history`, `Show remote-only files` and `Open dashboard` live in
the command palette under **Self Hosted Private Sync**, and the README
describes what each one does.
