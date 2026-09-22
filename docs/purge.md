# Purging a server

Wiping everything a server holds — every ciphertext chunk, every manifest,
every version — and starting again with the same devices or with new ones.

This is the one operation obsync has no button for, on purpose. It is not a
recovery step and nothing in the product will ever do it for you: the server
is the only copy of your version history, and a purge ends that history. The
vaults themselves are untouched, because the notes live on the devices.

> [!WARNING]
> A purge destroys every version of every note the server holds. The current
> note on each device survives — it is on that device — but "restore an
> earlier version" has nothing to read afterwards. If the history matters,
> take a volume backup first ([`recovery.md`](recovery.md), "The server is
> rebuilt from a volume backup") and keep it somewhere the purge cannot
> reach.

## When this is the right answer

- You are done testing and want the server to hold nothing.
- The volumes are full of a vault you no longer sync, and reclaiming the space
  matters more than the history.
- You are rebuilding the server from scratch for any other reason and do not
  want the old account, devices or chunks carried over.

It is NOT the answer to a device that will not sync, a conflict, a lost
device, a forgotten recovery phrase or a server you are moving to a new
address. Each of those has its own section in [`recovery.md`](recovery.md),
and each of them keeps your history.

## What a purge removes

Everything under the two volumes the server owns
([`storage.md`](storage.md)):

| Path | What goes with it |
| --- | --- |
| `/data/blobs` (and every mirror) | every ciphertext chunk of every version |
| `/data/journal` | every manifest, the version graph, the account, the devices, the pairing records |
| `/data/journal/v1/server_key` | the key that wraps every device secret |
| `/data/journal/v1/setup-token` | the one-time token; a new one is minted on the next first boot |

Your VAULT KEY is not there and never was: it exists only on your devices and
in the 24-word recovery phrase. That is why a purged server can be re-paired
into the same vault — the notes re-upload under the key the devices still
hold.

## The purge

1. **Stop the server.** A running server holds the journal lock and is
   writing; removing files under it is how you get a half-journal rather than
   an empty one.

   ```sh
   docker compose -f deploy/compose/docker-compose.yml down
   ```

   On Kubernetes, scale the deployment to zero and wait for the pod to go:

   ```sh
   kubectl scale deploy/obsync --namespace obsidian --replicas 0
   ```

2. **Remove the volumes.** Named Docker volumes go with the compose project:

   ```sh
   docker volume rm obsync_blobs obsync_journal
   ```

   Host directories are removed as their contents, so the mount points and
   their ownership survive:

   ```sh
   sudo find /srv/obsync/blobs /srv/obsync/journal -mindepth 1 -delete
   ```

   On Kubernetes, delete the PersistentVolumeClaims; whether the underlying
   volume is erased or retained is the StorageClass's reclaim policy, not
   this command's, so check it before you rely on either outcome.

3. **Start the server.** It provisions both volumes exactly as it did on the
   first boot: `700` on the roots, a new `server_key` at `600`, a new setup
   token at `600`, and one line per repair in the log
   ([`storage.md`](storage.md)).

4. **Read the new setup token.** It is a different token; the old one names
   nothing now.

   ```sh
   docker compose -f deploy/compose/docker-compose.yml exec obsync obsyncd setup-token
   ```

   [`recovery.md`](recovery.md), "Reading the setup token", has the Kubernetes
   and stopped-container forms.

## Re-pairing the devices

Every device still points at a server that no longer knows it: its stored
credential was minted by the server key that has just been replaced, so every
request earns `401 bad_signature`. Each device has to leave and pair again.

1. On the first device: **Settings → obsync → This device → Leave this
   server → Switch server**. It cannot revoke itself on a server that no
   longer holds it, so it offers to leave LOCALLY; take that. The vault key
   stays, which is what makes this the same vault.
2. Point it at the same **Server URL** and run **First-time setup** with the
   new token. It re-uploads the whole vault, because the server holds nothing.
3. On every other device, leave locally the same way, then pair with a code
   from the first device rather than the setup token
   ([`quickstart.md`](quickstart.md)).

A device that is paired again is a first sync for that device, so a note the
server already has at the same path arrives beside the local one as a conflict
copy ([`conflicts.md`](conflicts.md)). Let the first device finish uploading
before you pair the second, and there is nothing for the second to collide
with.

## Starting a different vault instead

If you want the server empty AND a new vault — not the same notes under a new
key — purge as above and then, on each device, **Vault key → Restore or
create → Create a new vault key**. That is a different vault to every part of
the system: new domain, new file ids, new manifests. The old recovery phrase
still opens the old history only if you kept a volume backup to open it
against.
