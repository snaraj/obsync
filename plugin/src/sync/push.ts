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
 * check already knows what landed.
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
import { ApiError, VersionAck } from "../transport";
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
  assertVaultPath(path);
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
  const ack = await postManifest(context, fileId, parents, sids, manifest, stat.size);
  context.state.setFile(path, {
    fileId,
    versionId: ack.versionId,
    mtime: stat.mtime,
    size: stat.size,
    sha256: digest,
  });
  await context.state.save();
  context.host.log(
    `push path_class=file bytes=${stat.size} chunks=${plan.length} uploaded=${uploads} decision=pushed duration_ms=${context.now() - started}`,
  );
  return { status: "pushed", fileId, versionId: ack.versionId, ack: ack.ack };
}

/** Post a tombstone: a version with `deleted:true` and no sids. */
export async function pushDelete(context: SyncContext, path: string): Promise<PushOutcome | null> {
  assertVaultPath(path);
  const record = context.state.fileByPath(path);
  if (!record) return null;
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
  const ack = await postManifest(context, record.fileId, parents, [], manifest, 0);
  context.state.forgetPath(path);
  await context.state.save();
  context.host.log(`push path_class=tombstone decision=deleted version=${ack.versionId}`);
  return { status: "pushed", fileId: record.fileId, versionId: ack.versionId, ack: ack.ack };
}

/**
 * Encrypt the manifest, compute the version id the server will recompute,
 * and post it. `409 missing_chunks` means the server garbage-collected a
 * chunk between the exists check and now: re-upload exactly those and retry
 * once.
 */
export async function postManifest(
  context: SyncContext,
  fileId: string,
  parents: string[],
  sids: string[],
  manifest: Manifest,
  bytes: number,
): Promise<{ versionId: string; ack: VersionAck }> {
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
    manifest_ct: base64(ciphertext),
    manifest_nonce: hex(nonce),
    deleted: manifest.deleted,
  };
  try {
    return { versionId: id, ack: await context.transport.postVersion(fileId, post) };
  } catch (error) {
    if (!(error instanceof ApiError) || error.code !== "missing_chunks") throw error;
    context.host.log(`push decision=retry reason=missing_chunks file=${fileId}`);
    await uploadMissing(context, new Set(sids), manifest.chunks, manifest.path, manifest.size);
    return { versionId: id, ack: await context.transport.postVersion(fileId, post) };
  }
}
