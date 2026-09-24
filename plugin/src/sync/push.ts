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
import type { FileRecord as FileState } from "../state";
import { CHUNK_MAX, chunkStream } from "../chunker";
import {
  Bytes,
  base64,
  concat,
  contentVersionId,
  decryptManifest,
  encryptChunk,
  encryptFolderManifest,
  encryptManifest,
  folderFileId,
  hex,
  randomBytes,
  sha256,
  unbase64,
  unhex,
  versionId,
} from "../crypto";
import { ApiError, FileRecord, UPLOAD_BUDGET_BYTES, VersionAck, VersionPost } from "../transport";
import { assertFolderCaseScope, assertFolderScope, assertSyncPath, inSyncScope } from "../syncScope";
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

/**
 * A FOLDER record: one version whose manifest names a path and nothing else.
 *
 * It is the same encrypted-manifest mechanism a file uses, with no chunks, no
 * bytes and no timestamp, so the server stores and feeds it exactly as it
 * stores a tombstone and learns exactly as little (requirement 6, and no
 * server change at all). `v: 2` is what makes it SAFE to send to the ~100
 * devices still on 1.0.x: their decoder refuses any manifest whose `v` is not
 * 1 before it reads another field, so a folder record can never become a FILE
 * written at the folder's path on a device that does not understand it.
 *
 * `kind` is redundant with `v` today and is carried anyway: `v` is the
 * compatibility gate, which a later record type would also have to move, and
 * `kind` is what says what this record IS to a reader holding it.
 *
 * NO `mtime`. A folder has no content to be newer or older than, and leaving
 * the field out is what makes the manifest two devices produce for the same
 * folder byte-identical — see `encryptFolderManifest`.
 */
export interface FolderManifest {
  v: 2;
  kind: "directory";
  path: string;
  domain: string;
  size: 0;
  chunks: never[];
  sha256: "";
  deleted: boolean;
}

export interface PushOutcome {
  /** `growing`: the file moved while it was being read, so no version exists. */
  status: "pushed" | "unchanged" | "growing";
  fileId: string;
  versionId: string;
  ack?: VersionAck;
}

/** SHA-256 over the concatenated sids: a size-independent content identity. */
export async function sidDigest(sids: string[]): Promise<string> {
  return hex(await sha256(concat(...sids.map(unhex))));
}

/**
 * Retire a file id that duplicates the note recorded at `path` under another
 * id (issue #131): one tombstone whose parent is `parent`, and nothing on disk.
 *
 * Only ever the HIGHER of two ids holding the same bytes at one name, or an id
 * whose twin another device has EDITED since (`takeEditedTwin`, issue #147).
 * Every device that settles an unedited pair settles it on the lower id, and a
 * device whose note has moved on from the shared bytes never takes the other
 * half for its twin, so two devices do not retire both halves -- which would
 * take the note off every device. The one exception is a device that edits the
 * note and restores the shared bytes exactly before it first pulls the twin.
 * A failure is reported, never raised: the note is already recorded under the
 * id that keeps it, so the cost is a duplicate id on the server.
 */
export async function retire(
  context: SyncContext,
  fileId: string,
  parent: string,
  path: string,
): Promise<"posted" | "failed"> {
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
  try {
    await postManifest(context, fileId, [parent], [], manifest, 0, true);
    return "posted";
  } catch {
    // The reason is not logged: a transport error names a path.
    return "failed";
  }
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

  // THE GROWING-FILE INVARIANT (issue #99). Everything above describes the
  // file as it was when the read STARTED. A file still being copied into the
  // vault keeps growing while it is read, so the plan, the size and the mtime
  // would be published as a truncated version of a file that is not finished:
  // a 916 MB copy reached other devices at 376 MB. The watcher's guard makes a
  // growing file wait, but it cannot see a copy that stalls longer than one
  // recheck, and startup reconciliation queues a path without consulting it at
  // all. So the size is read once more here, at the end of the read, and a
  // file that moved is abandoned BEFORE a version exists. Uploaded chunks are
  // content-addressed and unreferenced, so nothing durable was published; the
  // caller re-arms the debounce and the finished file is pushed whole.
  // Named for the read it closes, because this function now has a second
  // "after": the transport's upload counters, taken at the end for the
  // per-run summary. One name for two different measurements is how a
  // composition loses one of them.
  const afterRead = await context.host.stat(path);
  if (afterRead === null || afterRead.size !== stat.size || afterRead.mtime !== stat.mtime) {
    context.host.log(
      `push path_class=file decision=abandoned reason=changed_during_read bytes=${stat.size} ` +
        `bytes_after=${afterRead === null ? -1 : afterRead.size} duration_ms=${context.now() - started}`,
    );
    return { status: "growing", fileId, versionId: "" };
  }

  // A RECORD THAT APPEARED WHILE THIS PUSH READ (issue #131). A note this
  // device never published has no record, and the pull runs beside the queue:
  // meeting another device's version of the same bytes, it ADOPTS it --
  // records the name under the incoming id and publishes nothing. A new id
  // posted now would publish the note twice, and recording it would replace
  // the adoption, leaving two devices tracking two ids for one note: the
  // conflict copy of issue #131, one edit later. So an unpublished note's
  // record is read again at the last moment before a version exists, and one
  // that holds these same bytes IS this push.
  if (record === undefined) {
    const adopted = context.state.fileByPath(path);
    if (adopted !== undefined && adopted.sha256 === digest) {
      context.host.log(`push path_class=file decision=unchanged reason=recorded_during_read file=${adopted.fileId}`);
      return { status: "unchanged", fileId: adopted.fileId, versionId: adopted.versionId };
    }
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
  // AND ONE THAT APPEARED WHILE IT POSTED. The note is published twice by
  // then, and this device never pulls its own versions (`pull.ts`, ECHOES), so
  // it settles the pair here, by the rule every other device applies to it.
  if (record === undefined) {
    const adopted = context.state.fileByPath(path);
    if (adopted !== undefined && adopted.sha256 === digest) {
      return await settleDuplicate(context, path, adopted, { fileId, versionId: ack.versionId, mtime: stat.mtime, size: stat.size, sha256: digest }, ack.ack);
    }
  }
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
 * One note, published under two ids at one name (issue #131): the version
 * this push just posted, and the one the pull adopted while it posted. The
 * lower id keeps the name, exactly as `pull.ts` decides for a pair it meets on
 * the feed, and the higher one is retired. The note on disk is not touched.
 */
async function settleDuplicate(
  context: SyncContext,
  path: string,
  adopted: FileState,
  posted: FileState,
  ack: VersionAck,
): Promise<PushOutcome> {
  if (adopted.fileId < posted.fileId) {
    const retired = await retire(context, posted.fileId, posted.versionId, path);
    context.host.log(
      `push path_class=file decision=converged reason=recorded_during_post role=keep keeper=${adopted.fileId} retired=${posted.fileId} tombstone=${retired}`,
    );
    return { status: "unchanged", fileId: adopted.fileId, versionId: adopted.versionId };
  }
  context.state.setFile(path, posted);
  await context.state.save();
  const retired = await retire(context, adopted.fileId, adopted.versionId, path);
  context.host.log(
    `push path_class=file decision=converged reason=recorded_during_post role=yield keeper=${posted.fileId} retired=${adopted.fileId} tombstone=${retired}`,
  );
  return { status: "pushed", fileId: posted.fileId, versionId: posted.versionId, ack };
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
  const ack = await postManifest(context, record.fileId, parents, [], manifest, 0, true, () => stillGone(context, path, record, manifest.mtime))
    .catch((error: unknown) => {
      if (error instanceof ApiError && error.code === "withdrawn") return null;
      throw error;
    });
  if (ack === null) return null;
  context.state.forgetPath(path);
  await context.state.save();
  context.host.log(`push path_class=tombstone decision=deleted version=${ack.versionId}`);
  return { status: "pushed", fileId: record.fileId, versionId: ack.versionId, ack: ack.ack };
}

/**
 * Is a deletion whose first send was LOST still true, now that it is about to
 * be sent again (issue #173)? Settling the loss reads the file back with
 * retries -- 45 seconds of them in the battery -- and the answer `pushDelete`
 * checked before the first send is that old by now. The note may be back on
 * the disk, or the pull may have applied another device's change to it,
 * which replaces the record this deletion was decided from or moves it to
 * the note's new name. Sent anyway, the stale tombstone deletes a note that
 * is back and forks its file on the server for good.
 *
 * The device that deleted the note is the one that knows what happened, so
 * it is the one that says so -- when another device's change is why the note
 * is here, which the user did not do and would otherwise see as a note that
 * came back by itself. A note the user put back is theirs to know about.
 * `decided` is when the first send was decided -- the tombstone's own time --
 * so the line says how stale that decision had become.
 */
async function stillGone(context: SyncContext, path: string, record: FileState, decided: number): Promise<boolean> {
  const same = context.state.fileByPath(path) === record;
  const gone = same && (await context.host.stat(path)) === null;
  const reason = gone ? "still_gone" : same ? "file_present" : "record_changed";
  context.host.log(`push path_class=tombstone decision=${gone ? "resent" : "withdrawn"} reason=${reason} file=${record.fileId} ` +
    `age_ms=${context.now() - decided}`);
  const now = same ? undefined : context.state.pathByFileId(record.fileId);
  if (now !== undefined && (await context.host.stat(now)) !== null) {
    context.host.notify(
      `obsync did not delete "${path}" from your other devices: it was changed on another device before this ` +
        `deletion reached the server, so the note is back here as "${now}".`,
    );
  }
  return gone;
}

/** The manifest every folder record carries; `deleted` is the only choice. */
function folderManifest(context: SyncContext, path: string, deleted: boolean): FolderManifest {
  return { v: 2, kind: "directory", path, domain: context.domainId, size: 0, chunks: [], sha256: "", deleted };
}

/**
 * Publish the folder at `path`, once.
 *
 * A folder that this device already has a record for is already published —
 * by this device or by another one whose record this device pulled — and
 * re-posting it would buy a request and a second head for no change. That
 * early return is also what makes startup reconciliation and the vault's own
 * echo of a pull-created folder free (`engine.ts`).
 */
export async function pushFolder(context: SyncContext, path: string): Promise<string | null> {
  assertFolderScope(path, context.state.data.syncFolders);
  if (context.state.folderByPath(path) !== undefined) return null;
  const fileId = await folderFileId(context.manifestKey, path);
  const ack = await postManifest(context, fileId, [], [], folderManifest(context, path, false), 0, false);
  context.state.setFolder(path, { fileId, versionId: ack.versionId });
  await context.state.save();
  context.host.log(`folder path_class=folder decision=published reason=created version=${ack.versionId}`);
  return ack.versionId;
}

/** Tombstone a folder record. The files it held publish their own tombstones. */
export async function pushFolderDelete(context: SyncContext, path: string): Promise<string | null> {
  assertVaultPath(path);
  const record = context.state.folderByPath(path);
  if (record === undefined) return null;
  const parents = record.versionId !== "" ? [record.versionId] : [];
  const ack = await postManifest(context, record.fileId, parents, [], folderManifest(context, path, true), 0, false);
  context.state.forgetFolder(path);
  await context.state.save();
  context.host.log(`folder path_class=folder decision=published reason=deleted version=${ack.versionId}`);
  return ack.versionId;
}

/**
 * Encrypt the manifest, compute the version id the server will recompute,
 * and post it. `409 missing_chunks` means the server garbage-collected a
 * chunk between the exists check and now: ASK which sids it is missing and
 * re-upload exactly those, then retry once. The refusal names one sid, and
 * re-sending the plan on its word would re-send a 20 GiB archive to replace
 * one 4 MiB chunk (issue #56). `stillWanted` is asked immediately before a
 * LOST post is sent again (`postOnce`), and `false` withdraws it.
 */
export async function postManifest(
  context: SyncContext,
  fileId: string,
  parents: string[],
  sids: string[],
  manifest: Manifest | FolderManifest,
  bytes: number,
  acceptExisting: boolean,
  stillWanted: () => Promise<boolean> = async () => true,
): Promise<{ versionId: string; ack: VersionAck }> {
  // The folder rule for a folder record, the file rule for a file: the
  // selected folder itself has a record and is never a file (`syncScope.ts`).
  //
  // AND ITS CASE TOLERANCE, because the two halves of a rename that changes
  // capitalisation alone cannot both be in the selection: the selection moved
  // with the folder when the rename was handled, and the TOMBSTONE for the
  // name it left is posted afterwards, under the new one. Refused here, a
  // device renaming its own selected folder published the record and never
  // the tombstone, so every other device kept a folder record for a spelling
  // that no longer exists (review round 3, finding 1).
  if (manifest.v === 2) assertFolderCaseScope(manifest.path, context.state.data.syncFolders);
  else assertSyncPath(manifest.path, context.state.data.syncFolders);
  const binder = await contentVersionId(fileId, parents, sids);
  const seal = manifest.v === 2 ? encryptFolderManifest : encryptManifest;
  const { nonce, ciphertext } = await seal(
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
  // ADOPTION IS PROVED, NOT TAKEN ON TRUST. The store's identity for a
  // position is `(file_id, parent set, sids, deleted)` and cannot include
  // the path, which lives inside a manifest only a device holding the vault
  // key can read: two devices that edit one note to the same bytes from the
  // same parent are that key, whether or not one of them also RENAMED it.
  // Recording the other device's version as ours would put its path in our
  // record and mark its rename as this device's own echo, and the rename
  // would then be dropped on both sides. So a version this device did not
  // compute is read back and adopted only when its authenticated manifest
  // describes the SAME operation: same path, same size, same deleted bit.
  // Otherwise the post is repeated with the offer withdrawn, which is a
  // position the store must append.
  const settled = async (ack: VersionAck, retry: boolean): Promise<{ versionId: string; ack: VersionAck }> => {
    const answered = ack.version_id ?? id;
    if (answered === id || !retry) return { versionId: answered, ack };
    if (await sameOperation(context, fileId, answered, manifest)) return { versionId: answered, ack };
    context.host.log(
      `push path_class=file decision=not_adopted reason=other_manifest file=${fileId}`,
    );
    return await settled(await postOnce(context, fileId, id, { ...post, accept_existing: false }, stillWanted), false);
  };
  try {
    return await settled(await postOnce(context, fileId, id, post, stillWanted), acceptExisting);
  } catch (error) {
    if (!(error instanceof ApiError) || error.code !== "missing_chunks") throw error;
    const missing = new Set(await context.transport.missingChunks(sids));
    context.host.log(
      `push decision=retry reason=missing_chunks file=${fileId} chunks=${missing.size} of=${sids.length}`,
    );
    await uploadMissing(context, missing, manifest.chunks, manifest.path, manifest.size);
    return await settled(await postOnce(context, fileId, id, post, stillWanted), acceptExisting);
  }
}

/**
 * Does the version the store answered with describe the operation this
 * device just posted? Only a device holding the manifest key can say, and
 * only from the manifest itself: the clear fields the store matched on are
 * the very ones that are equal by construction.
 *
 * A version that cannot be read back at all is not adopted either -- an
 * unreadable answer is not a proof.
 */
async function sameOperation(
  context: SyncContext,
  fileId: string,
  answered: string,
  // A FOLDER RECORD IS TYPED THROUGH HERE, though it never arrives: folder
  // posts do not offer `accept_existing`, so their `settled` never retries
  // and never asks this question (issue #104). A folder manifest is sealed
  // under a DERIVED nonce, so two devices publishing one folder compute the
  // SAME version id and there is nothing to adopt; offering the existing
  // version instead makes the server answer a republication with the copy it
  // already holds and append nothing, which is how a folder this device has
  // lost its record for would stop being republished at all. `path`, `size`
  // and `deleted` are the three fields both shapes carry, so if a caller
  // ever does offer it, the guard holds rather than being typed out of reach.
  manifest: Manifest | FolderManifest,
): Promise<boolean> {
  try {
    const file = await context.transport.getFile(fileId);
    const version = file.versions.find((candidate) => candidate.version_id === answered);
    if (version === undefined) return false;
    const binder = await contentVersionId(fileId, version.parents, version.sids);
    const theirs = JSON.parse(
      await decryptManifest(
        context.manifestKey,
        fileId,
        binder,
        unhex(version.manifest_nonce),
        unbase64(version.manifest_ct),
      ),
    ) as Partial<Manifest>;
    return (
      theirs.path === manifest.path &&
      theirs.size === manifest.size &&
      theirs.deleted === manifest.deleted
    );
  } catch {
    return false;
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
 * be retried freely. The re-post is what the read's "absent" earns -- and
 * only while the caller still wants it: the read can take long enough for
 * the reason to post to have gone (`stillGone`, issue #173).
 */
async function postOnce(
  context: SyncContext,
  fileId: string,
  id: string,
  post: VersionPost,
  stillWanted: () => Promise<boolean>,
): Promise<VersionAck> {
  const sent = await context.transport.postVersion(fileId, post);
  if (sent.outcome === "ok") return sent.value;
  const committed = await committedAck(context, fileId, id);
  context.host.log(
    `push decision=reconciled reason=lost_answer file=${fileId} committed=${committed !== null}`,
  );
  if (committed) return committed;
  if (!(await stillWanted())) throw new ApiError(0, "withdrawn", fileId);
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
