/**
 * The push pipeline, `docs/architecture.md` 6.2 item 2.
 *
 * Read, chunk, encrypt, batch-check existence, upload what the server is
 * missing with bounded concurrency, then post the version. Nothing that
 * leaves this module is readable by the server: chunk bodies are ciphertext,
 * the path lives inside the encrypted manifest, and the only clear fields
 * are opaque ids, sizes and hashes of ciphertext (AGENTS.md requirement 6).
 *
 * ONE PASS, A WINDOW AT A TIME (issue #196). A file of at most 8 MiB is one
 * chunk, held with its ciphertext; a note's one small chunk is PUT without
 * asking first (`DIRECT_PUT_MAX`, issue #195). A larger file is read and
 * encrypted ONCE: each window of ciphertext is asked about in one
 * `POST /v1/chunks/exists` and what the server lacks is sent while it is still
 * in memory, and the version is posted only after every chunk has landed.
 * Peak memory is the window (`PUSH_WINDOW_BYTES`), so a 20 GB archive costs
 * the same as a 32 MiB file. Killing Obsidian mid-upload and reopening
 * resumes by `sid`: the exists check knows what landed. What the restart
 * must send AGAIN is whatever was in flight when the process died, which is
 * why the transport bounds those bytes rather than the number of requests
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
 * PLATFORM. Desktop streams the file through Node's `fs` in 8 MiB reads and
 * holds a 32 MiB window; mobile reads the whole file once through the vault
 * adapter, which is why the mobile per-file ceiling exists, and holds an
 * 8 MiB window beside it.
 */

import type { SyncContext } from "./engine";
import { GRAVES_MAX, type FileRecord as FileState } from "../state";
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
import { SyncFolders, assertFolderCaseScope, assertFolderScope, assertSyncPath, inSyncScope } from "../syncScope";
import { VaultPathError, assertVaultPath } from "../vaultPath";
import { quoted } from "../notices";

/**
 * The ciphertext one push holds between encrypting a chunk and the server
 * taking it (issue #196): what lets a large file be read and encrypted once
 * rather than twice. A phone holds less, beside the whole file its adapter
 * has already read.
 */
export const PUSH_WINDOW_BYTES = 32 << 20;
export const PUSH_WINDOW_MOBILE_BYTES = 8 << 20;

/**
 * A single chunk this small is PUT without asking first (issue #195): the PUT
 * is idempotent and the server verifies the body against its sid, so the
 * question costs a round trip to save at most this many bytes.
 */
export const DIRECT_PUT_MAX = 1 << 20;

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
  /**
   * On a RETIREMENT only (`retire`): the file id that keeps the name. A device
   * before 1.1.3 ignores it and applies an ordinary deletion.
   */
  keeper?: string;
  /** This edit answered a sync while no editor showed the note (#179). */
  answer?: true;
}

/** Encrypted coordination only; old plugins refuse v3 without touching a note. */
export interface PauseManifest {
  v: 3;
  kind: "pause";
  path: string;
  target: string;
  paused: boolean;
  domain: string;
  size: 0;
  chunks: never[];
  sha256: "";
  deleted: false;
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
  /**
   * `growing`: the file moved while it was being read, or what was read is the
   * empty file a dropped download left (#242), so no version exists.
   */
  status: "pushed" | "unchanged" | "growing";
  fileId: string;
  versionId: string;
  ack?: VersionAck;
}

/**
 * The file a push was asked for is no longer there (issue #164). Not a
 * failure: a note renamed, deleted or moved with its folder between the queue
 * and the read has an event of its own, and that event decides what is
 * published. No path in the message, because a name is vault content.
 */
export class PathGone extends Error {
  constructor() { super("push: path_gone"); }
}

/**
 * Remember a tombstone this device published or applied, for the one case
 * that needs it again: a server restored from a backup that predates it
 * (`restore.ts`, issue #145). The cap's drop is logged, never silent.
 */
export function bury(context: SyncContext, fileId: string, versionId: string, path: string, folder: boolean, ts?: number): void {
  const dropped = context.state.bury(fileId, { versionId, path, folder, ...(ts === undefined ? {} : { ts }) });
  if (dropped > 0) context.host.log(`grave decision=dropped reason=cap dropped=${dropped} budget=${GRAVES_MAX}`);
}

/** SHA-256 over the concatenated sids: a size-independent content identity. */
export async function sidDigest(sids: string[]): Promise<string> {
  return hex(await sha256(concat(...sids.map(unhex))));
}

/**
 * Retire a file id that duplicates the note recorded at `path` under `keeper`
 * (issue #131): one tombstone whose parent is `parent`, and nothing on disk.
 *
 * IT NAMES ITS KEEPER (issue #181), inside the manifest, so a device that
 * still maps the name to the retired id -- a record rolled back, S98 -- asks
 * the keeper before it deletes anything, and forgets only the retired id when
 * the keeper holds exactly the bytes it has (`pull.ts`, `retiredInto`).
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
  keeper: string,
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
    keeper,
  };
  try {
    await postManifest(context, fileId, [parent], [], manifest, 0, true);
    return "posted";
  } catch {
    // The reason is not logged: a transport error names a path.
    return "failed";
  }
}

/**
 * Read, encrypt and send a file of more than one chunk in ONE pass (issue
 * #196). `plan` fills in file order. Chunks are asked about a window at a
 * time, and what the server lacks is sent from memory: at most `limit` of
 * ciphertext is held between encrypting a chunk and the server taking it.
 * Resolves only once every chunk sent has LANDED -- the version is posted
 * after it, never beside it -- and answers how many were sent.
 */
async function sendChunks(context: SyncContext, path: string, size: number, plan: ManifestChunk[]): Promise<number> {
  const limit = context.host.isMobile ? PUSH_WINDOW_MOBILE_BYTES : PUSH_WINDOW_BYTES;
  const signal = context.signal;
  const landing = new Set<Promise<void>>();
  const asked = new Set<string>();
  let window: { sid: string; ciphertext: Bytes }[] = [];
  let windowBytes = 0;
  let held = 0;
  let sent = 0;
  const ask = async (): Promise<void> => {
    const chunks = window;
    window = [];
    windowBytes = 0;
    const missing = new Set(await context.transport.missingChunks(chunks.map((chunk) => chunk.sid), { signal }));
    for (const { sid, ciphertext } of chunks) {
      if (!missing.has(sid)) {
        held -= ciphertext.length;
        continue;
      }
      sent++;
      const upload: Promise<void> = context.transport.putChunk(sid, ciphertext, { signal }).finally(() => {
        held -= ciphertext.length;
        landing.delete(upload);
      });
      // Observed below; a stop can end it before the loop gets there.
      upload.catch(() => undefined);
      landing.add(upload);
    }
  };
  for await (const plaintext of chunkStream(context.host.source(path, size))) {
    // THE CHUNK BOUNDARY IS WHERE A STOP LANDS (issues #157, #185): nothing
    // after it is encrypted or sent, and what already landed is found by its
    // sid when the push runs again, so a folder Save or a Leave never waits
    // for the rest of a large upload.
    if (signal?.aborted === true) {
      // The chunks on the wire end by the same signal, at once.
      await Promise.allSettled(landing);
      throw new ApiError(0, "cancelled", "sync stopped on this device");
    }
    const { cid, sid, ciphertext } = await encryptChunk(context.domainKey, plaintext);
    plan.push({ sid, cid: hex(cid), len: plaintext.length });
    // A chunk a file repeats is asked about and sent once.
    if (asked.has(sid)) continue;
    asked.add(sid);
    // Half the window is asked about at once, so the other half can still be
    // on its way up while the next is encrypted.
    if (window.length > 0 && windowBytes + ciphertext.length > limit / 2) await ask();
    while (held + ciphertext.length > limit && landing.size > 0) await Promise.race(landing);
    window.push({ sid, ciphertext });
    windowBytes += ciphertext.length;
    held += ciphertext.length;
  }
  if (window.length > 0) await ask();
  await Promise.all(landing);
  return sent;
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
 *
 * `over` re-sends the file onto the parents a RESTORED server still holds,
 * in place of the recorded version it lost (`restore.ts`, issue #145): always
 * posted, and offered for deduplication, so two devices re-sending one lost
 * version publish one.
 */
const publications = new WeakMap<SyncContext, Map<string, Promise<unknown>>>();

/** The upload whose receipt a concurrent merge must include in its parents. */
export function pendingPublication(context: SyncContext, path: string): Promise<unknown> | undefined {
  return publications.get(context)?.get(path);
}

/** Uploads and merge writes observe the receipt left by the preceding publication. */
export async function serialPublication<T>(context: SyncContext, path: string, publish: () => Promise<T>): Promise<T> {
  let paths = publications.get(context);
  if (paths === undefined) { paths = new Map(); publications.set(context, paths); }
  const previous = paths.get(path);
  const current = (previous ?? Promise.resolve()).catch(() => undefined).then(publish);
  paths.set(path, current);
  try { return await current; }
  finally { if (paths.get(path) === current) paths.delete(path); }
}

/**
 * THE PATH A PUSH PUBLISHES, LINKED UNTIL ITS RECORD IS WRITTEN (issue #213).
 *
 * A note's first push has no record for a rename to move: the record is
 * written when the server answers. A new note renamed before then moved
 * nothing, so the rename's own push minted a second file id and the other
 * device received the note twice. The rename carries this link instead
 * (`carryPost`), the answer becomes the record at the new name (`publishFile`,
 * beside `path_gone`), and the rename's push waits for it here and publishes
 * a move of that id. A post that fails records nothing, and the moved note is
 * a new note, as before.
 */
interface InFlight { path: string; settled: Promise<void> }
const inFlight = new WeakMap<SyncContext, Map<string, InFlight>>();

/** A rename moved `from` while a push of it was in flight: its answer follows the note to `to`. */
export function carryPost(context: SyncContext, from: string, to: string): boolean {
  const posts = inFlight.get(context);
  const post = posts?.get(from);
  if (posts === undefined || post === undefined) return false;
  posts.delete(from);
  post.path = to;
  posts.set(to, post);
  return true;
}

export function pushFile(context: SyncContext, path: string, force = false, over?: string[] | (() => Promise<string[]>)): Promise<PushOutcome> {
  // Resume selects and preserves heads only after an earlier upload is acknowledged.
  // The name is resolved BEFORE it is serialised, so a push of either spelling
  // of one recorded note waits for the other rather than racing it (#166).
  return recordedSpelling(context, path).then((at) =>
    serialPublication(context, at, async () => {
      let posts = inFlight.get(context);
      if (posts === undefined) { posts = new Map(); inFlight.set(context, posts); }
      const carried = posts.get(at);
      if (carried !== undefined) await carried.settled;
      let settle = (): void => undefined;
      const post: InFlight = { path: at, settled: new Promise<void>((resolve) => { settle = resolve; }) };
      posts.set(at, post);
      try {
        return await publishFile(context, at, force, typeof over === "function" ? await over() : over, undefined, post);
      } finally {
        if (posts.get(post.path) === post) posts.delete(post.path);
        settle();
      }
    }));
}

/**
 * The name this device RECORDS for the entry `path` resolves to, when that
 * is `path` under other capitals (issue #166); otherwise `path`.
 *
 * A VAULT THAT FOLDS CASE ANSWERS FOR BOTH SPELLINGS, and Obsidian's index,
 * keyed by exact spelling, keeps reporting and listing the one an entry had
 * before the pull path re-cased it (S24, S93). A push of that old name found
 * no record under it -- the record moved with the entry -- and published the
 * note's bytes under a brand-new file id: one duplicate per note in a
 * re-cased folder, live on the server and tracked by no device, which a device
 * paired later adopted and then tried to delete. The vault is asked which
 * entry the name is, and an entry this device records under another spelling
 * is published as THAT record, never as a new file. A host that keeps the two
 * spellings apart answers with the name itself, which is a different file.
 *
 * Asked only when some record differs from `path` by case alone, which the
 * state answers from an index (`caseTwins`), so a new note costs no walk of
 * the records and no vault walk.
 */
async function recordedSpelling(context: SyncContext, path: string): Promise<string> {
  if (context.state.fileByPath(path) !== undefined) return path;
  if (context.state.caseTwins(path).length === 0) return path;
  const shown = await context.host.spelling(path);
  if (shown === null || shown === path || context.state.fileByPath(shown) === undefined) return path;
  context.host.log("push path_class=file decision=resolved reason=case_variant");
  return shown;
}

/** The edit wins; the tombstone becomes an ancestor, not a permanent second head. */
export function reviveFile(context: SyncContext, path: string, tombstone: string): Promise<PushOutcome> {
  return serialPublication(context, path, () => publishFile(context, path, true, undefined, tombstone));
}

async function publishFile(context: SyncContext, path: string, force = false, over?: string[], tombstone?: string, post?: InFlight): Promise<PushOutcome> {
  assertSyncPath(path, context.state.data.syncFolders);
  const stat = await context.host.stat(path);
  if (!stat) throw new PathGone();
  const record = context.state.fileByPath(path);
  const fileId = record?.fileId ?? hex(randomBytes(16));
  const domain = context.domainId;
  const started = context.now();

  const plan: ManifestChunk[] = [];
  let single: Bytes | null = null;
  let plaintextHash = "";
  let uploads = 0;
  const before = context.transport.uploadStats();
  if (stat.size <= CHUNK_MAX) {
    const plaintext = await context.host.read(path);
    // THE BYTES READ ARE WHAT IS JUDGED (#242; review of c4668d4). The engine
    // asks `droppedWrite` of a look taken before this push, and a download
    // dropped while that look was awaited left its empty file after it: read
    // here, it was published as the note. The name is marked before the
    // download writes (`materialise`), so empty bytes read at a marked name
    // are the drop's. Nothing is sent, and the caller looks again, as for a
    // file that changed while it was read.
    const mark = context.state.data.dropped[path];
    if (plaintext.length === 0 && mark !== undefined) {
      context.host.log(`push path_class=file decision=abandoned reason=write_dropped file=${mark} duration_ms=${context.now() - started}`);
      return { status: "growing", fileId, versionId: "" };
    }
    const { cid, sid, ciphertext } = await encryptChunk(context.domainKey, plaintext);
    plan.push({ sid, cid: hex(cid), len: plaintext.length });
    plaintextHash = hex(await sha256(plaintext));
    single = ciphertext;
  } else {
    uploads = await sendChunks(context, path, stat.size, plan);
  }

  const sids = plan.map((chunk) => chunk.sid);
  const digest = await sidDigest(sids);
  if (!force && record && record.sha256 === digest && record.versionId !== "") {
    // Only over the record it read: the pull may have given this name to
    // another note while this push read it (issue #149), and writing the old
    // one back would put that note under the wrong file id.
    if (context.state.fileByPath(path) === record) context.state.setFile(path, { ...record, mtime: stat.mtime, size: stat.size });
    return { status: "unchanged", fileId, versionId: record.versionId };
  }

  if (single !== null) {
    const only = plan[0] as ManifestChunk;
    // AN EDIT'S ONE SMALL CHUNK GOES STRAIGHT UP (issue #195): new bytes are
    // almost never on the server already, and the PUT is idempotent and
    // verified against its sid there. Bytes the record already names -- a
    // rename, a re-send over a restored server -- most likely are, so those
    // are asked about first.
    const direct = single.length <= DIRECT_PUT_MAX && record?.sha256 !== digest;
    if (direct || (await context.transport.missingChunks(sids, { signal: context.signal })).length > 0) {
      await context.transport.putChunk(only.sid, single, { signal: context.signal });
      uploads = 1;
    }
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
    ...(context.answering.get(fileId)?.mtime === stat.mtime && context.answering.get(fileId)?.arrived != null ? { answer: true as const } : {}),
  };
  const parents = tombstone === undefined
    ? over ?? (record && record.versionId !== "" ? [record.versionId] : [])
    : [...new Set([...(record?.versionId ? [record.versionId] : []), tombstone])];
  // A RENAME IS NEVER OFFERED FOR DEDUPLICATION. The server's identity for a
  // position is `(file_id, parent set, sids, deleted)` and does not cover the
  // encrypted manifest (`docs/protocol.md`, "One position, one version"), and
  // a forced post is exactly the case whose only new fact lives in there: the
  // path. Two devices renaming one note from the same version would otherwise
  // be answered with each other's id, record it, drop the other's frame as
  // their own echo -- `authored` -- and keep two different paths for one file
  // id with no version left that could settle it. Every other post offers it:
  // same parents, same chunks, same path is the same version (issue #114).
  const ack = await postManifest(context, fileId, parents, sids, manifest, stat.size, tombstone !== undefined || over !== undefined || !force);
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
  //
  // BUT A NOTE THAT ONLY MOVED IS STILL THIS DEVICE'S, AND ITS NEXT VERSION
  // DESCENDS FROM THIS ONE (issue #151). A rename landing while the manifest
  // posts carries the record to the new name with the parent this push read,
  // so the next push named that stale parent beside the version just posted
  // and forked the file: a swap made in one call lost a name on every device.
  // The record the rename carried -- found by file id, still naming the version
  // this push was made on -- learns the posted version, and nothing else about
  // it changes: the path it waits to publish is still unpublished. A record a
  // pull has moved on since, and a path that left the selection (#91), are
  // left exactly as they are.
  //
  // A FIRST POST THE RENAME CARRIED (issue #213) has no record to follow: its
  // answer IS the record, written at the note's new name and owing the move
  // there, exactly as `renamed` leaves a record it moves. A name taken by now,
  // or out of the selection, gets nothing, and the moved note is a new note.
  // One the rename has not reached yet is recorded where it was posted, gone
  // or not: the rename or deletion is an event of its own, and it, or the
  // scan after it, finds that record and moves or deletes it like any other.
  const renamed = record === undefined && post !== undefined && post.path !== path ? post.path : undefined;
  const inScope = inSyncScope(path, context.state.data.syncFolders);
  if (renamed !== undefined || !inScope || (record !== undefined && (await context.host.stat(path)) === null)) {
    const moved = renamed ?? (inScope && record !== undefined ? context.state.pathByFileId(fileId) : undefined);
    const carried = moved === undefined ? undefined : context.state.fileByPath(moved);
    const follows = renamed === undefined
      ? carried !== undefined && carried.versionId === record?.versionId
      : carried === undefined && inSyncScope(renamed, context.state.data.syncFolders);
    if (follows) {
      context.state.setFile(moved as string, carried === undefined
        ? { fileId, versionId: ack.versionId, mtime: -1, size: stat.size, sha256: "" }
        : { ...carried, versionId: ack.versionId });
      await context.state.save();
    }
    // And a note that LEFT the selection while this posted is brought back on
    // this version, not the one before it (`engine.ts`, `rejoin`; #239).
    const away = context.state.data.departed[fileId];
    const advanced = away !== undefined && away.versionId === record?.versionId;
    if (advanced) {
      away.versionId = ack.versionId;
      await context.state.save();
    }
    context.host.log(
      `push path_class=file decision=not_recorded reason=${renamed !== undefined ? "renamed" : inScope ? "path_gone" : "left_scope"} ` +
        `parent=${follows || advanced ? "advanced" : "kept"} file=${fileId}`,
    );
    return { status: "pushed", fileId, versionId: ack.versionId };
  }
  const current = context.state.fileByPath(path);
  if (record !== undefined && current?.fileId === fileId && current.versionId !== record.versionId) {
    // A peer can receive this upload, merge it and send its result back before
    // the upload acknowledgement arrives. Keep the newer pulled identity so
    // the next keystrokes descend from the content the editor actually loaded.
    context.host.log(`push path_class=file decision=not_recorded reason=record_advanced file=${fileId} duration_ms=${context.now() - started}`);
  } else {
    context.state.setFile(path, {
      fileId,
      versionId: ack.versionId,
      mtime: stat.mtime,
      size: stat.size,
      sha256: digest,
      // Its one chunk, for the repair walk (#198), as the pull records one
      // (`recordAt`). Left to the echo, it was lost whenever the feed brought
      // the version back before this acknowledgement: a third of an
      // uploading device's notes, each read back from the server once a
      // second for an hour after setup (#310).
      ...(sids.length === 1 ? { sid: sids[0] as string } : {}),
    });
    // A NEW NOTE OF ONE CHUNK WAITS FOR THE NEXT SAVE (issue #274), as a note
    // the pull creates does (#194). The data file is rewritten whole, and a
    // first sync rewrote it after every note it uploaded -- 478 MB of writes
    // for 1,501 notes, growing with the square of the vault -- while each
    // upload held its slot until the write was done. The record is saved by the
    // engine within `SAVE_COALESCE_MS`, when the queue drains, or at a stop.
    // A crash first loses the record, not the note: the next start asks the
    // feed for this device's own newest version at the name and records it
    // again while the note is still exactly what was posted (`engine.ts`,
    // `survey`, #181), so no second id is minted. An edit of a recorded note,
    // or a file of many chunks, is saved here as before.
    if (record === undefined && single !== null && context.defer !== undefined) context.defer();
    else await context.state.save();
  }
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
    const retired = await retire(context, posted.fileId, posted.versionId, path, adopted.fileId);
    context.host.log(
      `push path_class=file decision=converged reason=recorded_during_post role=keep keeper=${adopted.fileId} retired=${posted.fileId} tombstone=${retired}`,
    );
    return { status: "unchanged", fileId: adopted.fileId, versionId: adopted.versionId };
  }
  context.state.setFile(path, posted);
  await context.state.save();
  const retired = await retire(context, adopted.fileId, adopted.versionId, path, posted.fileId);
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
  const mark = context.state.data.dropped[path];
  if (!record && mark === undefined) return null;
  // ONE LOOK DECIDES (review of 5c9dc82). Asked twice, a file deleted
  // between the looks skipped the mark's rule below at the first and took
  // the ordinary tombstone at the second.
  if ((await context.host.stat(path)) !== null) {
    if (record) context.host.log("push path_class=tombstone decision=refused reason=file_present");
    return null;
  }
  // THE EMPTY FILE A DROPPED WRITE LEFT HELD NOTHING OF THE NOTE (#242;
  // review of 2e4cdca). Deleting it removes that placeholder, not the note,
  // whose text is on the server and on every other device: a tombstone would
  // take it from them all. This device forgets the mark, and any record.
  if (mark !== undefined) {
    if (record) context.state.forgetPath(path);
    delete context.state.data.dropped[path];
    await context.state.save();
    context.host.log(`push path_class=tombstone decision=skipped reason=write_dropped file=${mark}`);
    return null;
  }
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
  bury(context, record.fileId, ack.versionId, path, false);
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
    // The note by the name it was deleted under, and by the one it is back under when they differ.
    context.host.notify({
      kind: "info", paths: [now],
      text: now === path
        ? "did not delete {notes} from your other devices: another device changed {it} before the deletion reached " +
          "your server, so this device has {it} back."
        : `did not delete ${quoted(path)} from your other devices: another device changed it before the deletion reached ` +
          "your server, so this device has it back as {notes}.",
    });
  }
  return gone;
}

/** The manifest every folder record carries; `deleted` is the only choice. */
export function folderManifest(context: SyncContext, path: string, deleted: boolean): FolderManifest {
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
 *
 * A FOLDER MADE AGAIN WHERE ONE WAS DELETED IS A NEW VERSION (issue #165).
 * The record's file id is derived from its path and its manifest carries no
 * time, so the record for a path that ever had one is byte-for-byte that
 * path's FIRST version -- and the server answers a version it already holds
 * with a `200` that writes nothing (`docs/protocol.md`). Renaming `team docs`
 * back to `Team docs` therefore published the old spelling's tombstone and
 * the moves, and never the record that re-cases the directory on a device
 * that folds case: that device refused every move and blamed a version
 * difference the pair did not have. The answer names the file's heads, and a
 * creation (`recreate`) that is not among them is posted again over them,
 * which every device doing the same computes identically. The start-up
 * pass's publication of a folder that merely has no record here does not
 * recreate: a folder a tombstone found occupied and KEPT is nobody's to bring
 * back to the devices that deleted it (`docs/architecture.md` 6.2.0).
 */
export async function pushFolder(context: SyncContext, path: string, recreate = false): Promise<string | null> {
  assertFolderScope(path, context.state.data.syncFolders);
  if (context.state.folderByPath(path) !== undefined) return null;
  // A LINKED FOLDER'S NAME IS NOT PUBLISHED (issue #167). The string rule
  // passes a link; the filesystem's no-follow walk does not, and every folder
  // publication -- a create event, a rename, the start-up pass -- asks it
  // here, where a file's publication already met it. The host logs the
  // refusal and tells the user once.
  if (!(await context.host.syncable(path, "folder"))) return null;
  const fileId = await folderFileId(context.manifestKey, path);
  const manifest = folderManifest(context, path, false);
  let ack = await postManifest(context, fileId, [], [], manifest, 0, false);
  let reason = "created";
  if (recreate && !ack.ack.heads.includes(ack.versionId)) {
    ack = await postManifest(context, fileId, ack.ack.heads, [], manifest, 0, false);
    reason = "recreated";
  }
  context.state.setFolder(path, { fileId, versionId: ack.versionId });
  await context.state.save();
  context.host.log(`folder path_class=folder decision=published reason=${reason} version=${ack.versionId}`);
  return ack.versionId;
}

/**
 * Tombstone a folder record. The files it held publish their own tombstones.
 * `judged` is the selection the removal was decided against (`postManifest`).
 */
export async function pushFolderDelete(context: SyncContext, path: string, judged?: SyncFolders): Promise<string | null> {
  assertVaultPath(path);
  const record = context.state.folderByPath(path);
  if (record === undefined) return null;
  const parents = record.versionId !== "" ? [record.versionId] : [];
  const ack = await postManifest(context, record.fileId, parents, [], folderManifest(context, path, true), 0, false, undefined, judged);
  context.state.forgetFolder(path);
  bury(context, record.fileId, ack.versionId, path, true);
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
  manifest: Manifest | FolderManifest | PauseManifest,
  bytes: number,
  acceptExisting: boolean,
  stillWanted: () => Promise<boolean> = async () => true,
  judged?: SyncFolders,
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
  //
  // AND A FOLDER'S REMOVAL AGAINST THE SELECTION IT WAS JUDGED IN (issue
  // #240), for the rename that changes more than capitalisation: the
  // selection followed the folder before the old name's tombstone was posted,
  // so every other device kept an empty folder under that name. Only the
  // removals the engine decided carry `judged`; left out, or judged against
  // the whole vault, it is the selection in force now -- a selection set in
  // between makes the check stricter, never wider. A FILE is checked against
  // the selection in force, always.
  if (manifest.v === 2) assertFolderCaseScope(manifest.path, judged ?? context.state.data.syncFolders);
  else assertSyncPath(manifest.path, context.state.data.syncFolders);
  // AND NEVER A PATH IN A VAULT OF ITS OWN (issue #180), whatever asked for
  // the post: a rename, a tombstone and a folder record reach here without
  // the host's `syncable`, and any of them publishes that vault's changes.
  if (await context.host.inNestedVault(manifest.path)) throw new VaultPathError("nested_vault");
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
    // Collected between the check and the post: the file is read once more
    // and what the server now lacks is sent. A chunk the file no longer holds
    // is still missing, and the server says so again.
    const sent = await sendChunks(context, manifest.path, manifest.size, []);
    context.host.log(
      `push decision=retry reason=missing_chunks file=${fileId} chunks=${sent} of=${sids.length}`,
    );
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
  manifest: Manifest | FolderManifest | PauseManifest,
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
    ) as Partial<Manifest | PauseManifest>;
    return (
      theirs.path === manifest.path &&
      theirs.size === manifest.size &&
      theirs.deleted === manifest.deleted &&
      (manifest.v !== 3 || (theirs.v === 3 && theirs.kind === "pause" && theirs.target === manifest.target && theirs.paused === manifest.paused))
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
