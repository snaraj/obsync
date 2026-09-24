# Plugin settings

Every row in Settings → Community plugins → Self Hosted Private Sync, what it
defaults to, and when it is worth changing. The rows are
`plugin/src/ui/settings.ts`; both ceilings default per platform from
`plugin/src/policy.ts`, this device's **Name** from `defaultDeviceName()` in
`plugin/src/main.ts`, and the rest from the row itself. Obsidian indexes every
row for its settings search, so typing a row's name in the search box finds it.

Everything here is **per device**. Nothing in this tab is synced, and no other
device can change it for you.

## Get started

| Setting | Default | What it does | When to change it |
| --- | --- | --- | --- |
| **Setup guide** → **Open the guide** | — | Opens this project's setup guide in your browser. The address ships with the plugin; the plugin itself sends nothing there. | When you set up a server or add a device |

## Server

| Setting | Default | What it does | When to change it |
| --- | --- | --- | --- |
| **Server URL** | empty | Where this device sends every sync request. A host name alone becomes `https://host`; give the port when it is not 443 (`host:8443`). HTTPS only on iOS and Android. | Once at setup, and again if the server moves ([`recovery.md`](recovery.md)) |
| **Edge service-token headers** | empty | One `name: value` per line, sent with every request. For a deployment with an access-controlled proxy in front of the server. | Only if your edge requires a service token. Leave empty otherwise |
| **Connection** → **Check** | — | Asks the server who it is and reports the account name and device count. | Any time you want one round trip to prove the address, the certificate and the credential together |
| **Connection** → **Open dashboard** | — | Mints a single-use sign-in link and opens the dashboard. The link is resolved against the Server URL above and opened only if it stays on that origin. | — |
| **Update available** → **Open Community plugins** | shown only when the server reports a newer plugin version than this device runs | One sentence naming the plugin and both versions, and a button that opens Obsidian's own Community plugins page, where **Check for updates** installs. The 15-second notice says the same thing and opens the same page when you tap it. Nothing here installs code: the plugin never fetches its own bundle from the sync server. | — |

## Sync folders on this device

| Setting | Default | What it does | When to change it |
| --- | --- | --- | --- |
| **Folder selection** | Whole vault | `Whole vault`, or `Selected folders only`. Its description reads back what this device is syncing NOW, which is the saved selection. Hidden folders (`.obsidian`, `.git`) and symlinked folders are excluded either way. | Before the first sync, if the vault also holds code or private files |
| **Selected folders** | empty | One relative folder per line. An empty list with `Selected folders only` syncs nothing, and saving one says so. A folder the vault does not have is asked about before it is saved, with Cancel as the default; a folder typed in another case (`notes` for `Notes`) is saved the way the vault spells it, and a notice says so. | With the setting above |
| **Save on this device** → **Save** | — | Waits for transfers actually running, never for an idle connection to the server, then rescans. **Set up** and **Pair this device** do this for you when the selection on screen is not yet saved. | After a change on a device that already syncs |

The selection can only NARROW once a device has synced. To sync more of this
vault, move the files into a folder that is already selected and run **Sync
now**. Removed folders keep their local files and their history on the server.

## This device

| Setting | Default | What it does | When to change it |
| --- | --- | --- | --- |
| **Pairing** → **Pair this device** | — | Applies an unsaved folder selection, then opens the dialog that takes a pairing code from a device that already syncs. On a device that syncs already it claims nothing and says to leave the server first. Before the first sync it asks when this vault holds notes the server's vault does not. | On every device after the first |
| **Pairing** → **Pair a new device** | — | Mints a code, valid ten minutes, for another device to claim. | When adding a device |
| **First-time setup** → **Set up** | — | Takes the setup token the server wrote at first boot, applies an unsaved folder selection, creates the account and enrolls this device. The token is not spent: it stays the dashboard's recovery sign-in. The dashboard calls the account `obsync`. | Once, on the first device |
| **Name** | the platform and a short device id, e.g. `macos-1a2b` | How this device appears in the dashboard's device list and in another device's conflict copies. | Give each device a name you will recognise months later |
| **Largest file to download** | `0` (unlimited) on desktop, `512 MiB` on mobile | Files above it stay on the server and appear under **Show remote-only files**, to fetch on demand. | On a phone with room to spare, or one with none. `0` means unlimited. Sizes read as `1 MB`, `2 GB` (decimal) or `1 MiB`, `2 GiB` (binary); anything else is refused with a notice when you leave the field |
| **Total to keep on this device** | `0` (unlimited) on desktop, `50 GiB` on mobile | Above this total, new files stay remote-only. | Same |
| **Save to server** → **Save** | — | Sends the name and both ceilings together, so the dashboard shows what this device will actually hold. | After changing any of the three above |
| **Leave this server** → **Leave** | — | Revokes THIS device on the server, then forgets the server address, the edge headers, the sync cursor and every file record. Every note stays in the vault. | Retiring this device, or handing the computer on |
| **Leave this server** → **Switch server** | — | The same, then asks for the new address and opens **Pair this device** for it. | Moving this vault to a different server |

Mobile ceilings exist because Obsidian on a phone reads and writes whole files
in memory: a ceiling is what keeps one large attachment from ending the app.
Desktop streams files in 8 MiB windows, which is why it has no practical
ceiling.

Leaving asks first, and says what it costs. **Kept:** every note, the vault
key (so pairing again is the SAME vault, never a new one), this device's name,
its folder selection and both ceilings. **Lost:** this device's sync identity.
It is refused while this device holds changes the server never received — the
dialog names them, and either **Sync now** first or discard them on purpose.
It is also refused for the only ACTIVE device (`409 last_device`), because an
account with no active device can never sync again; that dialog offers to
leave locally instead, which forgets the server and leaves the device enrolled
on it. Pairing again is a first sync for this device, so where the server
already holds a note at the same path the local note stays and the server's
copy arrives beside it as a conflict copy
([`conflicts.md`](conflicts.md)).

## Devices

Every device on the account, one row each, with **Revoke** beside each one not
already revoked; **Device list** → **Refresh** reads the list again.
Revocation destroys that device's wrapped secret on the server and is final —
a revoked device is paired again as a new device.

## Vault key

| Setting | What it does |
| --- | --- |
| **Recovery phrase** → **Show** | Re-displays the 24 words from this device's own key. Anyone holding them can read this vault |
| **Recovery phrase** → **Restore or create** | **Restore** adopts an existing vault key from its phrase, and refuses words that open nothing on a server that holds a vault. **Create a new vault key** starts a NEW vault that existing devices will not read, and asks first on a server that holds one — see [`recovery.md`](recovery.md) before pressing it |

## Commands, not settings

`Sync now`, `Show sync status`, `Pair a new device`, `Show recovery phrase`,
`Restore from history`, `Show remote-only files`, `Open dashboard`,
`Leave this server` and `Switch server` live in the command palette under
**Self Hosted Private Sync**, and the README describes what each one does.
