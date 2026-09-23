# Quickstart

The first device and the second one, every step in full. It assumes your own
server is already running; if it is not, start with [Run the server](server.md)
and come back here. The five screenshots below are from the device run this
release was validated on; the sections after them are the same path in full.

<!-- Capture rule (AGENTS.md, docs/captures/README.md): the five files below
     are committed PNGs from a validated device run, displayed in the declared
     form that scripts/ci/test_capture_contract.py pins. A change to what the
     plugin or the dashboard renders asks the owner for fresh captures. -->

## Get synced in five steps

The path this release was validated on, from an empty vault to two devices in
sync. All five assume your own server is already running.

1. **Install from Community plugins.** In Settings → Community plugins →
   Browse, search for **Self Hosted Private Sync** and select Install, then
   Enable — the same way every other Obsidian plugin arrives, on every
   platform.

   ![Obsidian's Community plugins browser showing Self Hosted Private Sync with its Install button](captures/01-install-from-directory.png)

2. **Point it at your server and set it up.** Open the plugin's settings tab,
   set **Server URL** to your own server, choose which folders this device
   syncs, then paste your setup token under **First-time setup**.

   ![The plugin settings tab scrolled to the folder selection, Pairing, and the First-time setup token field](captures/02-first-time-setup.png)

3. **Keep the recovery phrase.** Setup generates the vault key on this device
   and shows a 24-word phrase once: write it down and keep it somewhere other
   than this device, because the server holds ciphertext only and cannot
   recover a vault for you.

   ![The recovery-phrase dialog shown after first-time setup, its words obscured](captures/03-recovery-phrase.png)

4. **Pair a second device with a one-time code.** Run **Pair a new device** on
   the first device, enter the code it shows on the second within ten minutes,
   and approve the device by name — the vault key travels encrypted under a
   pairing secret the server never sees.

   ![The Pair a new device dialog on the first device, its one-time code obscured](captures/04-pair-a-new-device.png)

5. **Edit on either device and watch it land.** Type in a note on one device
   and it appears on the other within seconds, in both directions, with the
   status bar showing what sync is doing.

   ![The disposable note carrying both devices' edits, with the sync status bar visible](captures/05-sync-both-ways.png)

The dashboard's device list and its revoke button are described under
See your devices in the daily-use page and were not exercised in the 1.0.0
device run recorded in the validation runs for 2026-09-14.

## Set up this computer (the first device)

Use Obsidian 1.13.0 or newer on each device. Credentials and vault keys use
Obsidian's native secret storage; unavailable storage stops setup and sync.

1. In your vault, open Settings → Community plugins and allow community
   plugins. Select Browse and search for **Self Hosted Private Sync**.
2. Select **Install**, then **Enable**. No hidden folders or manual file
   copies are part of installation.
3. Open the Self Hosted Private Sync settings tab. Set **Server URL** to the
   URL your devices reach the server at, port included when it is not 443
   (`https://name:8443`). If an access-controlled edge sits in front of the
   server, paste its headers under **Edge service-token headers**, one per
   line as `Name: value`.

   ![The plugin's settings tab: the Server URL field holding a demo host name, the edge headers box, and the Connection row with its Check and Open dashboard buttons](assets/settings-server.png)

4. Under **Sync folders on this device**, choose **Selected folders only**
   if the vault also contains code or files you do not want shared, and
   enter relative folders such as `Notes`, one per line. **Set up** and
   **Pair this device** apply what you typed; **Save** applies it on its own.
   An empty selected list syncs no files; **Whole vault** is the default.
   Select the final folders now: after sync has history, the selection may
   only narrow. To stage a first sync within one vault, keep personal files
   in an excluded folder, test disposable notes inside the selected folder,
   then move the personal files in and run **Sync now**.
5. Under **First-time setup**, paste the setup token and select **Set up**:

   ![The This device section of the settings tab: the Pairing row with Pair this device and Pair a new device, the First-time setup row with the Setup token field and the Set up button, and the Vault key row](assets/settings-setup.png)

   the plugin creates the account and this device, generates the vault key
   on this computer, and shows the **recovery phrase** (24 words).
   Write it down and keep it off this machine: without any paired device and
   without this phrase, the vault is unrecoverable by design. The server never
   sees the key. [`recovery.md`](recovery.md) is what the phrase
   does and does not get you back.
6. Sync starts. The status bar shows the state; the command **Sync now**
   forces a pass, and **Show sync status** explains what it is doing.

Existing installations migrate their own credentials before removing them
from plugin data. Keep the vault and recovery phrase intact if a storage
error appears. Check Obsidian's secret storage and reload; do not delete the
credential reference or repeat server setup. A partially enrolled device
still needs approval before an existing recovery phrase can restore sync.
A pending pairing dialog does not resume after app restart. Secret storage is
shared with other trusted plugins in that vault and is not an OS or plugin
isolation boundary. Native restart persistence is a separate validation step.

## Pair your phone

1. In the phone's local vault, install and enable **Self Hosted Private Sync** through Settings →
   Community plugins → Browse. Set the same **Server URL** and connect to
   its private network if needed. The server must provide HTTPS trusted by
   the phone. Choose this phone's folder selection before pairing; **Pair this
   device** applies it, and it is local, not copied by the pairing code.
   Files keep their relative folder names.
2. On the computer, run the command **Pair a new device** (also a button in
   the settings tab). It shows a one-time pairing code, valid ten minutes, and
   an `obsidian://obsync-private-sync/pair?code=...` link you can send yourself.

   ![The Pair a new device dialog on the first device, its code obscured, with Copy code and Copy link buttons and the line Waiting for the new device](assets/pair-new-device.png)

3. On the phone, open **Pair this device** in the settings tab, paste the code
   under **Pairing code** and tap **Pair** — or open the link, which is the
   same dialog with the code already in it.

   ![The Pair this device dialog on the second device, with the empty Pairing code field and the Pair button](assets/pair-this-device.png)

   Phone screenshots are not in this repository yet; the dialog above is the
   same one on a computer. They are taken on the maintainer's own devices and
   added when a validation run records them.
4. Back on the computer, approve the device by its name when asked. The phone
   receives the vault key encrypted under a pairing secret that never touches
   the server; until you approve, the phone has no authority of any kind.

   ![The first device asking whether to approve the new device by name, with Approve and Reject buttons](assets/pair-approve.png)

5. Edit a note on the phone. It appears on the computer within seconds, and
   the other way round. That is the whole loop.

   ![The second device showing the note written on the first device, with the status bar reading obsync idle](assets/first-sync.png)

The whole exchange in one loop, both devices being computers:

![Animated: the pairing code shown on the first device, pasted on the second, approved on the first, and the first note arriving on the second](assets/pairing.gif)

## Next

- [Daily use](daily-use.md): the commands, the status bar, what syncs, the
  dashboard, and how to restore a retained version.
- [Troubleshooting](troubleshooting.md): symptom, cause, fix.
