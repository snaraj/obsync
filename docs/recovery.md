# Recovery

What to do when a device, a credential, or the server is gone. Every path here
is one the shipped code supports; where there is no path, this page says so
rather than implying one.

## The four secrets, and what each one protects

| Secret | Where it lives | What it unlocks | If you lose it |
| --- | --- | --- | --- |
| The **vault key**, written out as the 24-word recovery phrase | on each paired device, in Obsidian's secret storage | your notes: every chunk and every file name | the stored content cannot be read by anyone, you included |
| A **device secret** | on that device, wrapped under the server key on the server | that device's access to the server | pair the device again |
| The **server key** (`OBSYNC_SERVER_KEY`) | the operator's Secret, or the journal volume | the wrapped device secrets | every device must pair again — and see "every device is gone" below |
| The **setup token** | `v1/setup-token` on the journal volume | creating the account once, and signing in to the dashboard forever after | mint a new one (below) |

The server holds none of the first one and cannot read a note. That is the
design, and it is also the reason recovery has the shape it does.

## A device is lost or stolen

1. **Revoke it** — the dashboard's Devices list, or **Devices** in the plugin
   settings on another paired device. Revocation destroys that device's
   wrapped secret on the server; it is final, and a revoked device gets
   `403 device_revoked` for every request it tries. It also ends that
   device's hold on the dashboard: any sign-in link it minted stops working,
   and any dashboard session opened from one of its links is closed at the
   same moment.

   **Two things revocation does not do.** It cannot be undone — there is no
   un-revoke route and no CLI that restores a revoked device, so the way
   back is to pair that device again as a new one, which gives it a new
   device id and a new secret. And it is refused outright for the only
   ACTIVE device, from the dashboard and from the plugin alike
   (`409 last_device`): an account with no active device can never sync
   again, and nothing in this release re-enrols one. Pair the replacement
   first, then revoke.
2. **Pair the replacement** from a device that still syncs: **Pair a new
   device** there, the code on the new one, approval back on the first. The
   vault key travels inside the pairing envelope, encrypted under a secret the
   server never sees, so the recovery phrase is not needed for this.

The lost device keeps whatever plaintext was already in its vault folder. That
is a device-security problem (disk encryption, remote wipe), not something a
sync server can undo.

## A device's plugin data is gone, but other devices still sync

A reinstall, a cleared secret storage, or a vault copied without its
`.obsidian` folder. The device has no credential and no vault key, and the
plugin says `not paired`.

Pair it again from a device that still syncs. If it ends up enrolled but
without a vault key, the **Vault key** dialog offers two buttons, and only one
of them is recovery:

- **Restore**, with the 24 words, adopts the existing vault key: the device
  reads the history that is already on the server.
- **Create a new vault key** starts a NEW vault. Existing devices will not read
  it and the old content stays unreadable to this device. It is the right
  button only when you are deliberately starting over.

## Every device is gone

Say it plainly: **there is no supported path back to your notes in this
version.**

- A new device cannot enroll itself. `POST /v1/setup` creates the account once
  and answers `409 already_set_up` afterwards, and a pairing can only be opened
  BY a device that is already paired.
- The recovery phrase restores a vault key onto a device; it does not enroll
  one.
- `obsyncd export` writes the stored CIPHERTEXT (`<file_id>.bin.enc` plus the
  encrypted manifests). The server implements no AES, so it cannot write
  plaintext, and nothing else in this release can either.

What this means in practice: your devices are the copies. Keep more than one
paired, and keep an ordinary backup of the vault folder on at least one of
them. The recovery phrase protects the key, not the account.

## The server is rebuilt from a volume backup

**What the volumes hold.** `obsync-blobs` is every ciphertext chunk.
`obsync-journal` is the journal (the source of truth), the index snapshots, the
setup token, and — only when `OBSYNC_SERVER_KEY` is not supplied — the
generated server key. Treat the journal volume as the sensitive one.

**What a consistent backup needs.** Both volumes from the same moment, with the
server stopped, or a filesystem or volume snapshot that captures them together.
The journal is append-only and replays on start, so a backup taken while the
server was writing recovers to the last complete frame and says which frames
survived. A blobs backup NEWER than its journal is safe; a journal newer than
its blobs is not, because it names chunks the restored blob volume does not
hold.

**What to restore, in order.** The server key first (the Secret, or the file on
the journal volume), then both volumes, then start the server and read
`/readyz`. It answers `{"ready":true,"seq":<n>}` only once the volumes are writable and
the journal has replayed.

**Two ways this bites:**

- **A journal older than a pairing.** Devices paired after that backup do not
  exist in the restored index, and every request they make is refused
  `401 bad_signature`. Pair them again from a device the restore does know.
- **A lost server key.** Every device secret was wrapped under it, so no device
  can authenticate and no device can open a pairing for a new one. That is the
  "every device is gone" case, arriving from the server's side. Back the key up
  the way you back up a password.

## Reading the setup token

Ask the server: `obsyncd setup-token` prints the token that stands on the
journal volume on standard output, alone and newline terminated, and nothing
else — every diagnostic is on standard error and the token reaches no log
line. It reads the same file a start reads, through the same measured volume
pass, and opens no journal, so it answers from a server that is serving:
`kubectl exec deploy/obsync -- obsyncd setup-token` on Kubernetes,
`docker compose exec obsync obsyncd setup-token` under Compose, neither
needing a shell the image does not have.

It exits non-zero and names the reason when there is nothing to print: no
token stands on these volumes yet (`reason=absent`, the state between the two
steps below), the file is not a token (`reason=corrupt`), or the volume itself
is refused (`reason=unsafe_posture`). Reading the file off the volume — the
node's copy, or a read-only mount of the claim — stays the fallback for a
server that is not running; `chart/README.md` and `README.md` have the exact
commands for each deployment.

## Minting a new setup token

The token is written once, at first boot, and then stands: it is the
dashboard's recovery sign-in for the life of the server. To replace one you
believe is exposed:

1. Stop the server.
2. Delete `v1/setup-token` from the journal volume.
3. Start the server.

It mints a new 64-hex token, writes it mode 0600, and logs
`event=setup_token_ready … state=recovery_login` — never the token itself. The
old token stops working the moment the file is replaced. Existing devices are
unaffected: they authenticate with their own secrets, not with this token.

**How to tell it has been used.** A sign-in with this token logs
`event=dashboard_login decision=recovery_login` at `warn` — never the token,
not even a prefix — and the dashboard's Overview page carries a notice for as
long as that session lasts. A sign-in from a device's link logs
`decision=link_login` at `info` instead. If you see the first and did not do
it, rotate the token with the three steps above and use **Sign out
everywhere** on the dashboard, which closes every session the server holds.

**Who holds it.** Whoever can read the journal volume. Its custody is the
dashboard's custody, and that is why it is worth rotating after a restore
from a backup somebody else handled ([`security/dashboard.md`](security/dashboard.md)).

## Moving this vault to a different server

A different server INSTANCE, not the same one at a new address: a rebuilt
server, a second one you are migrating to, or a laptop's test server you are
done with. The device credential is bound to the server that minted it, so
changing **Server URL** alone earns `401 bad_signature` for ever.

1. On the device, **This device** → **Leave this server** → **Switch server**.
   It revokes this device on the old server, forgets the server address, the
   edge headers, the feed cursor and every file record, and then asks for the
   new address and opens **Pair this device** for it.
2. Pair against the new server: a code from a device that already syncs this
   vault there, or **First-time setup** with that server's setup token if the
   new server has no account yet. Either way the VAULT KEY on this device is
   kept, so this is the same vault; a new key would be a new vault
   ([`settings.md`](settings.md)).
3. The only ACTIVE device cannot be revoked (`last_device`, above). The dialog
   offers to leave LOCALLY instead: this device forgets the server and keeps
   every note, and the server keeps the device — revoke it from the dashboard,
   or from another device, once one is paired. A server that does not
   recognise this device at all (`401 bad_signature`: rebuilt, or restored
   from an older backup) makes the same offer, and a device already revoked
   simply leaves.

Pairing again is a first sync for this device, so anything the new server
already holds at the same path arrives beside the local note as a conflict
copy ([`conflicts.md`](conflicts.md)). Nothing in the vault is deleted at any
point.

## Moving the server to a new address

The address is not part of any key; it is what each device is configured with.

1. Stand the server up at the new address, with a certificate that name's
   devices trust.
2. On each device, set **Server URL** to the new address, port included when it
   is not 443. The stored credential is re-bound to the new address as the
   setting is saved; the device id and its secret do not change.
3. If the deployment names itself to its clients (`OBSYNC_PUBLIC_URL`, or the
   chart's `publicUrl`), update that too, so generated dashboard links point at
   the address devices actually use.

A device whose plugin data and stored credential disagree about the address
stops with a storage error instead of guessing
([`community-plugin.md`](community-plugin.md)); it does not silently sync to
the wrong server.
