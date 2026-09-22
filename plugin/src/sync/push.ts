/**
 * The push pipeline, `docs/architecture.md` 6.2 item 2.
 *
 * Read, chunk, encrypt, batch-check existence, upload what the server is
 * missing with bounded concurrency, then post the version. Nothing that
 * leaves this module is readable by the server: chunk bodies are ciphertext,
 * the path lives inside the encrypted manifest, and the only clear fields
 * are opaque ids, sizes and hashes of ciphertext (AGENTS.md requirement 6).
 *
 * TWO PASSES ABOVE ONE CHUNK. A file of at most 8 MiB is one chunk and is
 * handled in a single pass holding its ciphertext. A larger file is streamed
 * TWICE: pass one derives `{sid, cid, len}` per chunk and discards the
 * ciphertext, so one `POST /v1/chunks/exists` can cover thousands of chunks;
 * pass two re-encrypts (deterministically — `encryptChunk` is a pure
 * function of the domain key and the plaintext, so the second pass produces
 * the same bytes) and uploads only the missing ones. Peak memory is
 * `concurrency × 8 MiB`, so a 20 GB archive costs the same as an 8 MiB note.
 * Killing Obsidian mid-upload and reopening resumes by `sid`: the exists
 * check already knows what landed. What the restart must send AGAIN is
 * whatever was in flight when the process died, which is why the transport
 * bounds those bytes rather than the number of requests
 * (`UPLOAD_INFLIGHT_MAX`) and why this module never re-sends a plan it has
 * not re-checked. Every run that chunks a file, and every run that re-sent a
 * byte, says so in one `upload decision=summary` line.
 *
 * MANIFEST `sha256`. It carries the plaintext SHA-256 for a single-chunk
 * file. For a multi-chunk file it is the empty string: WebCrypto has no
 * streaming digest and a homegrown SHA-256 is forbidden (AGENTS.md
 * requirement 5), so whole-file hashing would mean holding a 20 GB file in
 * memory. Integrity for those files is per chunk and strictly keyed: `cid =
 * HMAC(K_d, plaintext)` is verified inside `decryptChunk` on every pull, and
 * the chunk list itself is bound into the manifest's AAD.
 *
 * WHAT IS PUSHED. Only a canonical relative vault path: the watcher gate and
 * these two entry points both apply the rule, so a hidden file — the plugin's
 * own `data.json` above all — cannot be uploaded even if an event names one
 * (`vaultPath.ts`).
 *
 * PLATFORM. Desktop streams the file through Node's `fs` in 8 MiB windows
 * with concurrency 4; mobile reads the whole file through the vault adapter
 * with concurrency 2, which is why the mobile per-file ceiling exists.
 */

import type { SyncContext } from "./engine";
import { CHUNK_MAX, chunkStream } from "../chunker";
import {
  Bytes,
  base64,
  concat,
  contentVersionId,
  encryptChunk,
  encryptManifest,
  hex,
  randomBytes,
  sha256,
  unhex,
  versionId,
} from "../crypto";
import { ApiError, FileRecord, UPLOAD_BUDGET_BYTES, VersionAck, VersionPost } from "../transport";
import { assertSyncPath, inSyncScope } from "../syncScope";
import { assertVaultPath } from "../vaultPath";

export interface ManifestChunk {
  sid: string;
  /** Keyed content id, required to derive the chunk key. Never leaves the manifest. */
  cid: string;
  len: number;
}

export interface Manifest {
  v: 1;
  path: string;
  size: number;
  mtime: number;
  domain: string;
  chunks: ManifestChunk[];
  sha256: string;
  deleted: boolean;
}

export interface PushOutcome {
  status: "pushed" | "unchanged";
  fileId: string;
  versionId: string;
  ack?: VersionAck;
}

/** SHA-256 over the concatenated sids: a size-independent content identity. */
export async function sidDigest(sids: string[]): Promise<string> {
  return hex(await sha256(concat(...sids.map(unhex))));
}

async function uploadMissing(
  context: SyncContext,
  missing: Set<string>,
  plan: ManifestChunk[],
  path: string,
  size: number,
): Promise<void> {
  if (missing.size === 0) return;
  const source = context.host.source(path, size);
  const queue: Promise<void>[] = [];
  for await (const plaintext of chunkStream(source)) {
    const { sid, ciphertext } = await encryptChunk(context.domainKey, plaintext);
    if (!missing.has(sid)) continue;
    missing.delete(sid);
    queue.push(context.transport.putChunk(sid, ciphertext));
    if (queue.length >= context.concurrency) {
      await Promise.all(queue.splice(0, queue.length));
    }
  }
  await Promise.all(queue);
  if (missing.size > 0) {
    throw new Error(`push: ${missing.size} chunk(s) of ${plan.length} vanished mid-upload`);
  }
}

/**
 * Push one vault file. Returns `unchanged` when re-chunking reproduces the
 * chunk list the local state already recorded, which is what makes startup
 * reconciliation and a touched-but-unedited file free.
 *
 * `force` posts a version even when the content is identical. A rename is
 * exactly that case: the bytes did not move, the PATH did, and the path lives
 * inside the manifest — without this a renamed file would keep its old name
 * on every other device.
 */
export async function pushFile(context: SyncContext, path: string, force = false): Promise<PushOutcome> {
  assertSyncPath(path, context.state.data.syncFolders);
  const stat = await context.host.stat(path);
  if (!stat) throw new Error(`push: ${path} disappeared`);
  const record = context.state.fileByPath(path);
  const fileId = record?.fileId ?? hex(randomBytes(16));
  const domain = context.domainId;
  const started = context.now();

  const plan: ManifestChunk[] = [];
  let single: Bytes | null = null;
  let plaintextHash = "";
  if (stat.size <= CHUNK_MAX) {
    const plaintext = await context.host.read(path);
    const { cid, sid, ciphertext } = await encryptChunk(context.domainKey, plaintext);
    plan.push({ sid, cid: hex(cid), len: plaintext.length });
    plaintextHash = hex(await sha256(plaintext));
    single = ciphertext;
  } else {
    for await (const plaintext of chunkStream(context.host.source(path, stat.size))) {
      const { cid, sid } = await encryptChunk(context.domainKey, plaintext);
      plan.push({ sid, cid: hex(cid), len: plaintext.length });
    }
  }

  const sids = plan.map((chunk) => chunk.sid);
  const digest = await sidDigest(sids);
  if (!force && record && record.sha256 === digest && record.versionId !== "") {
    context.state.setFile(path, { ...record, mtime: stat.mtime, size: stat.size });
    return { status: "unchanged", fileId, versionId: record.versionId };
  }

  const before = context.transport.uploadStats();
  const missing = new Set(await context.transport.missingChunks(sids));
  const uploads = missing.size;
  if (single !== null) {
    const only = plan[0] as ManifestChunk;
    if (missing.has(only.sid)) await context.transport.putChunk(only.sid, single);
  } else {
    await uploadMissing(context, missing, plan, path, stat.size);
  }

  const manifest: Manifest = {
    v: 1,
    path,
    size: stat.size,
    mtime: stat.mtime,
    domain,
    chunks: plan,
    sha256: plaintextHash,
    deleted: false,
  };
  const parents = record && record.versionId !== "" ? [record.versionId] : [];
  // A RENAME IS NEVER OFFERED FOR DEDUPLICATION. The server's identity for a
  // position is `(file_id, parent set, sids, deleted)` and does not cover the
  // encrypted manifest (`docs/protocol.md`, "One position, one version"), and
  // a forced post is exactly the case whose only new fact lives in there: the
  // path. Two devices renaming one note from the same version would otherwise
  // be answered with each other's id, record it, drop the other's frame as
  // their own echo -- `authored` -- and keep two different paths for one file
  // id with no version left that could settle it. Every other post offers it:
  // same parents, same chunks, same path is the same version (issue #114).
  const ack = await postManifest(context, fileId, parents, sids, manifest, stat.size, !force);
  // A PUSH THAT OUTLIVES ITS PATH RECORDS NOTHING. Everything above is
  // asynchronous -- chunk uploads especially -- and the file can leave this
  // device's selection while they are in flight: the rename handler forgets
  // the path on purpose, so that the next scan does not read its absence as
  // a deletion and take the note off every other device (issue #91). Writing
  // the record here would put that path back and arm exactly that tombstone.
  // The version itself is published and stays published; what this device
  // declines to do is claim it still tracks a path it no longer syncs.
  const inScope = inSyncScope(path, context.state.data.syncFolders);
  if (!inScope || (await context.host.stat(path)) === null) {
    context.host.log(
      `push path_class=file decision=not_recorded reason=${inScope ? "path_gone" : "left_scope"} file=${fileId}`,
    );
    return { status: "pushed", fileId, versionId: ack.versionId };
  }
  context.state.setFile(path, {
    fileId,
    versionId: ack.versionId,
    mtime: stat.mtime,
    size: stat.size,
    sha256: digest,
  });
  await context.state.save();
  // The upload's own receipt: what crossed the wire while this run was in
  // flight and the budget it is measured against (requirement 12). The
  // counters are the TRANSPORT's, so a second push running beside this one is
  // counted here too; what the budget bounds is the device's re-sent bytes,
  // not one file's. A one-chunk run that re-sent nothing has nothing to
  // summarise beyond `uploaded=`.
  const after = context.transport.uploadStats();
  const resent = after.resent - before.resent;
  if (plan.length > 1 || resent > 0) {
    context.host.log(
      `upload decision=summary chunks=${after.chunks - before.chunks} retried=${resent} ` +
        `budget=${UPLOAD_BUDGET_BYTES} deduped=${after.deduped - before.deduped} duration_ms=${context.now() - started}`,
    );
  }
  context.host.log(
    `push path_class=file bytes=${stat.size} chunks=${plan.length} uploaded=${uploads} decision=pushed duration_ms=${context.now() - started}`,
  );
  return { status: "pushed", fileId, versionId: ack.versionId, ack: ack.ack };
}

/**
 * Post a tombstone: a version with `deleted:true` and no sids.
 *
 * AND ONLY FOR A FILE THAT IS REALLY GONE. A tombstone deletes the file on
 * EVERY device, and both things that queue one speak from a moment that has
 * already passed: a vault delete event, and the startup scan, which infers a
 * deletion from a LISTING it took before it walked the state (`engine.ts`).
 * A version arriving from another device is written and recorded inside that
 * gap, so its path is in the record and not in the listing, and the file the
 * inference names is sitting on the disk -- where this would delete it,
 * everywhere, and drop the record that says what it was. So the file is asked
 * for once more, here, at the moment the decision is actually made, and a
 * file that is there is not a deletion. The caller publishes it as the change
 * it is.
 */
export async function pushDelete(context: SyncContext, path: string): Promise<PushOutcome | null> {
  assertVaultPath(path);
  // Before any I/O, as `pushFile` does it: a path this device does not sync
  // is refused without the vault being touched at all (`scope.test.mjs`).
  assertSyncPath(path, context.state.data.syncFolders);
  const record = context.state.fileByPath(path);
  if (!record) return null;
  if ((await context.host.stat(path)) !== null) {
    context.host.log("push path_class=tombstone decision=refused reason=file_present");
    return null;
  }
  const manifest: Manifest = {
    v: 1,
    path,
    size: 0,
    mtime: context.now(),
    domain: context.domainId,
    chunks: [],
    sha256: "",
    deleted: true,
  };
  const parents = record.versionId !== "" ? [record.versionId] : [];
  // Two devices deleting one file from the same version say the same thing,
  // and the tombstone flag is part of what the server compares, so a delete
  // is never answered with a live version of the same position. The same
  // manifest blind spot applies in principle -- a tombstone's manifest names
  // a path -- and matters less, because a deleted file has no later path for
  // the two devices to disagree about.
  const ack = await postManifest(context, record.fileId, parents, [], manifest, 0, true);
  context.state.forgetPath(path);
  await context.state.save();
  context.host.log(`push path_class=tombstone decision=deleted version=${ack.versionId}`);
  return { status: "pushed", fileId: record.fileId, versionId: ack.versionId, ack: ack.ack };
}

/**
 * Encrypt the manifest, compute the version id the server will recompute,
 * and post it. `409 missing_chunks` means the server garbage-collected a
 * chunk between the exists check and now: ASK which sids it is missing and
 * re-upload exactly those, then retry once. The refusal names one sid, and
 * re-sending the plan on its word would re-send a 20 GiB archive to replace
 * one 4 MiB chunk (issue #56).
 */
export async function postManifest(
  context: SyncContext,
  fileId: string,
  parents: string[],
  sids: string[],
  manifest: Manifest,
  bytes: number,
  acceptExisting: boolean,
): Promise<{ versionId: string; ack: VersionAck }> {
  assertSyncPath(manifest.path, context.state.data.syncFolders);
  const binder = await contentVersionId(fileId, parents, sids);
  const { nonce, ciphertext } = await encryptManifest(
    context.manifestKey,
    fileId,
    binder,
    JSON.stringify(manifest),
  );
  const id = await versionId(fileId, parents, ciphertext, sids);
  const post = {
    version_id: id,
    parents,
    sids,
    bytes,
    // The one new clear field: which domain the file is in, so phase-2
    // authorization has something to filter on (`docs/architecture.md` 5.1
    // item 4). It is a random id; without the owner-only map it names no path.
    domain_id: context.domainId,
    manifest_ct: base64(ciphertext),
    manifest_nonce: hex(nonce),
    deleted: manifest.deleted,
    accept_existing: acceptExisting,
  };
  // The id the STORE holds for this post, which is the posted one unless the
  // server answered with a version it already had at this position. A server
  // older than 1.0.7 sends no such field and the computed id stands, which is
  // also what the lost-answer settlement returns, because it only settles on
  // finding THIS id in the file record (issue #114).
  const settled = (ack: VersionAck): { versionId: string; ack: VersionAck } => ({
    versionId: ack.version_id ?? id,
    ack,
  });
  try {
    return settled(await postOnce(context, fileId, id, post));
  } catch (error) {
    if (!(error instanceof ApiError) || error.code !== "missing_chunks") throw error;
    const missing = new Set(await context.transport.missingChunks(sids));
    context.host.log(
      `push decision=retry reason=missing_chunks file=${fileId} chunks=${missing.size} of=${sids.length}`,
    );
    await uploadMissing(context, missing, manifest.chunks, manifest.path, manifest.size);
    return settled(await postOnce(context, fileId, id, post));
  }
}

/**
 * Post one version, and settle a lost answer by READING rather than guessing.
 *
 * A version post is not repeatable, so the transport sends it once and says
 * `lost` when nothing answered: the server may hold the version, or may never
 * have seen it. Calling it failed drops an edit this device already believes
 * it offered. Guessing the other way and re-sending is survivable only
 * because THIS body hashes to THIS version id, which the server no-ops
 * (`docs/protocol.md`) — a property of the id, not of the request — and it
 * still buys a second write, a second nonce, and a `409 missing_chunks` if
 * the server collected a chunk in between. Reading the file record answers
 * the question that was actually asked, and reading IS repeatable, so it can
 * be retried freely. The re-post is what the read's "absent" earns.
 */
async function postOnce(
  context: SyncContext,
  fileId: string,
  id: string,
  post: VersionPost,
): Promise<VersionAck> {
  const sent = await context.transport.postVersion(fileId, post);
  if (sent.outcome === "ok") return sent.value;
  const committed = await committedAck(context, fileId, id);
  context.host.log(
    `push decision=reconciled reason=lost_answer file=${fileId} committed=${committed !== null}`,
  );
  if (committed) return committed;
  // Absent: a fresh signature over the same body is a first post, not a repeat.
  const again = await context.transport.postVersion(fileId, post);
  if (again.outcome === "ok") return again.value;
  throw new ApiError(0, "lost", `${fileId}: ${again.reason}`);
}

/** The ack the file record implies, or `null` when the version never landed. */
async function committedAck(
  context: SyncContext,
  fileId: string,
  id: string,
): Promise<VersionAck | null> {
  let file: FileRecord;
  try {
    file = await context.transport.getFile(fileId);
  } catch (error) {
    // A file whose FIRST version was the lost one does not exist yet.
    if (error instanceof ApiError && error.status === 404) return null;
    throw error;
  }
  return file.versions.some((version) => version.version_id === id)
    ? { heads: file.heads, conflicted: file.conflicted }
    : null;
}
