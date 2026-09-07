/**
 * The pull path, `docs/architecture.md` 6.2 items 3 and 4.
 *
 * For each change-feed record not authored here: decrypt the manifest,
 * check it against this device's policy, download the missing chunks,
 * decrypt them, verify, and write the file atomically. Every chunk is
 * verified as it is decrypted (`decryptChunk` recomputes `cid = HMAC(K_d,
 * plaintext)`), and a single-chunk file additionally has its plaintext
 * SHA-256 checked against the manifest before anything reaches the vault.
 * Nothing is written unverified.
 *
 * ECHOES. A write this device made comes back down the feed. It is dropped
 * twice over: by `version_id` (the ids this device authored) and by the
 * `(path, mtime, size)` of the writes this device made, which is what stops
 * the vault watcher from pushing our own pull back up.
 *
 * CONFLICTS. When the server reports more than one head and ours is not the
 * incoming one, a text file with a reachable common ancestor takes the
 * three-way merge and the merged text is posted with BOTH heads as parents.
 * Everything else keeps both sides: the foreign head is written as
 * `<name> (conflict from <device>, <date>).<ext>` and the user is told.
 * Merging is attempted only for single-chunk text files; above that a
 * conflict copy is the honest answer.
 *
 * PLATFORM. Desktop writes through a temp file and a rename (Node `fs`),
 * so a crash mid-write cannot leave a torn note, and streams a file of any
 * size. Mobile buffers the file and writes it with `adapter.writeBinary`,
 * which is why the mobile per-file ceiling exists; a file above the ceiling
 * is never downloaded and is listed as remote-only instead.
 */

import type { SyncContext } from "./engine";
import { CHUNK_MAX } from "../chunker";
import {
  Bytes,
  contentVersionId,
  decryptChunk,
  decryptManifest,
  encryptChunk,
  hex,
  sha256,
  unbase64,
  unhex,
} from "../crypto";
import { ChangeRecord } from "../transport";
import { admissionReason, admit } from "../policy";
import { conflictCopyPath, isMergeableText, threeWayMerge } from "./conflict";
import { Manifest, ManifestChunk, postManifest, sidDigest } from "./push";

/** Cap on one batched chunk fetch: 64 sids, and never more than 32 MiB in flight. */
const BATCH_SIDS = 64;
const BATCH_BYTES = 32 << 20;

export type ApplyResult =
  | "echo"
  | "applied"
  | "deleted"
  | "remote_only"
  | "merged"
  | "conflict_copy"
  | "skipped";

export async function decryptRecordManifest(
  context: SyncContext,
  record: Pick<ChangeRecord, "file_id" | "parents" | "sids" | "manifest_ct" | "manifest_nonce">,
): Promise<Manifest> {
  const binder = await contentVersionId(record.file_id, record.parents, record.sids);
  const json = await decryptManifest(
    context.manifestKey,
    record.file_id,
    binder,
    unhex(record.manifest_nonce),
    unbase64(record.manifest_ct),
  );
  return JSON.parse(json) as Manifest;
}

/** Fetch, decrypt and verify every chunk of a manifest, in file order. */
async function* chunkPlaintexts(context: SyncContext, manifest: Manifest): AsyncGenerator<Bytes> {
  let index = 0;
  while (index < manifest.chunks.length) {
    const batch: ManifestChunk[] = [];
    let bytes = 0;
    while (
      index < manifest.chunks.length &&
      batch.length < BATCH_SIDS &&
      (batch.length === 0 || bytes + (manifest.chunks[index] as ManifestChunk).len <= BATCH_BYTES)
    ) {
      const chunk = manifest.chunks[index] as ManifestChunk;
      batch.push(chunk);
      bytes += chunk.len;
      index++;
    }
    const bodies =
      batch.length === 1
        ? [await context.transport.getChunk((batch[0] as ManifestChunk).sid)]
        : await context.transport.getChunks(batch.map((chunk) => chunk.sid));
    for (let i = 0; i < batch.length; i++) {
      const body = bodies[i];
      const chunk = batch[i] as ManifestChunk;
      if (!body) throw new Error(`pull: chunk ${chunk.sid} is missing on the server`);
      yield await decryptChunk(context.domainKey, unhex(chunk.cid), body);
    }
  }
}

/** Assemble a whole file in memory. Only used for merge inputs, which are single-chunk. */
export async function assembleBytes(context: SyncContext, manifest: Manifest): Promise<Bytes> {
  const parts: Bytes[] = [];
  for await (const part of chunkPlaintexts(context, manifest)) parts.push(part);
  const out = new Uint8Array(manifest.size);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/**
 * Write a manifest's content into the vault atomically and return the stat
 * of what landed, which becomes the echo-suppression key.
 */
async function materialise(context: SyncContext, manifest: Manifest): Promise<void> {
  const writer = await context.host.writer(manifest.path);
  try {
    if (manifest.chunks.length === 1) {
      const only = await firstChunk(context, manifest);
      if (manifest.sha256 !== "" && hex(await sha256(only)) !== manifest.sha256) {
        throw new Error(`pull: plaintext hash mismatch for ${manifest.path}`);
      }
      await writer.write(only);
    } else {
      for await (const part of chunkPlaintexts(context, manifest)) await writer.write(part);
    }
    const stat = await writer.commit(manifest.mtime);
    context.written.add(`${stat.path}:${stat.mtime}:${stat.size}`);
  } catch (error) {
    await writer.abort();
    throw error;
  }
}

async function firstChunk(context: SyncContext, manifest: Manifest): Promise<Bytes> {
  for await (const part of chunkPlaintexts(context, manifest)) return part;
  return new Uint8Array(0);
}

/**
 * Apply one change-feed record.
 */
export async function applyChange(context: SyncContext, change: ChangeRecord): Promise<ApplyResult> {
  if (context.authored.has(change.version_id)) {
    context.authored.delete(change.version_id);
    return "echo";
  }
  if (change.device_id === context.deviceId) return "echo";

  const manifest = await decryptRecordManifest(context, change);
  const localPath = context.state.pathByFileId(change.file_id);
  const local = localPath === undefined ? undefined : context.state.fileByPath(localPath);

  if (manifest.deleted) {
    if (localPath !== undefined) {
      await context.host.trash(localPath);
      context.state.forgetPath(localPath);
      await context.state.save();
      context.host.log(`pull path_class=tombstone decision=deleted seq=${change.seq}`);
      return "deleted";
    }
    delete context.state.data.remoteOnly[change.file_id];
    return "skipped";
  }

  if (local && local.versionId === change.version_id) return "skipped";

  const admission = admit(context.state.data.policy, context.state.localBytes(), manifest.size);
  if (!admission.ok) {
    context.state.data.remoteOnly[change.file_id] = { path: manifest.path, size: manifest.size };
    await context.state.save();
    context.host.log(
      `pull path_class=file bytes=${manifest.size} decision=remote_only reason=${admission.reason} seq=${change.seq}`,
    );
    return "remote_only";
  }

  if (change.conflicted && local && !change.parents.includes(local.versionId)) {
    return await reconcile(context, change, manifest, localPath as string, local.versionId);
  }

  const started = context.now();
  await materialise(context, manifest);
  if (localPath !== undefined && localPath !== manifest.path) {
    await context.host.trash(localPath);
    context.state.forgetPath(localPath);
  }
  const stat = await context.host.stat(manifest.path);
  context.state.setFile(manifest.path, {
    fileId: change.file_id,
    versionId: change.version_id,
    mtime: stat?.mtime ?? manifest.mtime,
    size: stat?.size ?? manifest.size,
    sha256: await sidDigest(change.sids),
  });
  await context.state.save();
  context.host.log(
    `pull path_class=file bytes=${manifest.size} chunks=${manifest.chunks.length} decision=applied seq=${change.seq} duration_ms=${context.now() - started}`,
  );
  return "applied";
}

/**
 * Download a file this device previously declined, ignoring the ceiling
 * because the user asked for this one by name.
 */
export async function fetchRemoteOnly(context: SyncContext, fileId: string): Promise<string> {
  const file = await context.transport.getFile(fileId);
  const head = file.versions.find((version) => version.version_id === (file.heads[0] ?? ""));
  if (!head) throw new Error("remote-only: the file has no readable head");
  const manifest = await decryptRecordManifest(context, head);
  await materialise(context, manifest);
  const stat = await context.host.stat(manifest.path);
  context.state.setFile(manifest.path, {
    fileId,
    versionId: head.version_id,
    mtime: stat?.mtime ?? manifest.mtime,
    size: stat?.size ?? manifest.size,
    sha256: await sidDigest(head.sids),
  });
  await context.state.save();
  context.host.log(`pull path_class=file bytes=${manifest.size} decision=fetched_on_demand`);
  return manifest.path;
}

/** The newest version reachable from both heads, or `null`. */
export function commonAncestor(
  versions: { version_id: string; parents: string[] }[],
  left: string,
  right: string,
): string | null {
  const byId = new Map(versions.map((version) => [version.version_id, version]));
  const reach = (start: string): Set<string> => {
    const seen = new Set<string>();
    const queue = [start];
    while (queue.length > 0) {
      const id = queue.pop() as string;
      if (seen.has(id)) continue;
      seen.add(id);
      for (const parent of byId.get(id)?.parents ?? []) queue.push(parent);
    }
    return seen;
  };
  const fromLeft = reach(left);
  for (const id of versions.map((version) => version.version_id)) {
    if (fromLeft.has(id) && reach(right).has(id) && id !== left && id !== right) return id;
  }
  return null;
}

/**
 * Two heads on one file. Merge when we can prove a base and the content is
 * mergeable text; otherwise keep both sides.
 */
async function reconcile(
  context: SyncContext,
  change: ChangeRecord,
  theirManifest: Manifest,
  localPath: string,
  localVersionId: string,
): Promise<ApplyResult> {
  const file = await context.transport.getFile(change.file_id);
  const baseId = commonAncestor(file.versions, localVersionId, change.version_id);
  const mine = await context.host.read(localPath);
  const mergeable =
    baseId !== null &&
    theirManifest.chunks.length === 1 &&
    theirManifest.size <= CHUNK_MAX &&
    isMergeableText(localPath, mine);

  if (mergeable) {
    const baseRecord = file.versions.find((version) => version.version_id === baseId);
    if (baseRecord) {
      const baseManifest = await decryptRecordManifest(context, baseRecord);
      const base = await assembleBytes(context, baseManifest);
      const theirs = await assembleBytes(context, theirManifest);
      const decoder = new TextDecoder();
      const merged = threeWayMerge(decoder.decode(base), decoder.decode(mine), decoder.decode(theirs));
      if (merged.ok) {
        const text = new TextEncoder().encode(merged.text) as Bytes;
        const writer = await context.host.writer(localPath);
        await writer.write(text);
        const stat = await writer.commit(context.now());
        context.written.add(`${stat.path}:${stat.mtime}:${stat.size}`);
        await postMerged(context, change, localPath, localVersionId, text, stat.mtime);
        context.host.notify(`obsync merged concurrent edits to ${localPath}.`);
        context.host.log(`pull decision=merged file=${change.file_id} seq=${change.seq}`);
        return "merged";
      }
      context.host.log(`pull decision=conflict_copy reason=${merged.reason} file=${change.file_id}`);
    }
  }

  const copyPath = conflictCopyPath(
    theirManifest.path,
    context.deviceNameFor(change.device_id),
    new Date(context.now()),
  );
  await materialise(context, { ...theirManifest, path: copyPath });
  context.host.notify(
    `obsync kept both versions of ${theirManifest.path}. The other device's copy is "${copyPath}".`,
  );
  context.host.log(
    `pull decision=conflict_copy file=${change.file_id} seq=${change.seq} bytes=${theirManifest.size}`,
  );
  return "conflict_copy";
}

/** Post the merge result as one version whose parents are BOTH heads. */
async function postMerged(
  context: SyncContext,
  change: ChangeRecord,
  path: string,
  localVersionId: string,
  text: Bytes,
  mtime: number,
): Promise<void> {
  const { cid, sid, ciphertext } = await encryptChunk(context.domainKey, text);
  const missing = await context.transport.missingChunks([sid]);
  if (missing.length > 0) await context.transport.putChunk(sid, ciphertext);
  const manifest: Manifest = {
    v: 1,
    path,
    size: text.length,
    mtime,
    domain: context.domainId,
    chunks: [{ sid, cid: hex(cid), len: text.length }],
    sha256: hex(await sha256(text)),
    deleted: false,
  };
  const parents = [localVersionId, change.version_id].sort();
  const posted = await postManifest(context, change.file_id, parents, [sid], manifest, text.length);
  context.authored.add(posted.versionId);
  context.state.setFile(path, {
    fileId: change.file_id,
    versionId: posted.versionId,
    mtime,
    size: text.length,
    sha256: await sidDigest([sid]),
  });
  await context.state.save();
}

/** Remote-only accounting for the "Remote only" view. */
export function remoteOnlyList(context: SyncContext): { fileId: string; path: string; size: number; why: string }[] {
  const policy = context.state.data.policy;
  return Object.entries(context.state.data.remoteOnly).map(([fileId, record]) => {
    const admission = admit(policy, context.state.localBytes(), record.size);
    return {
      fileId,
      path: record.path,
      size: record.size,
      why: admission.ok ? "available" : admissionReason(policy, admission.reason),
    };
  });
}
