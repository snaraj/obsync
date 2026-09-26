/**
 * A server rebuilt from a volume backup (issue #145, `docs/recovery.md`).
 *
 * Everything journaled after the backup is gone from the server and NOT from
 * the devices that made it or pulled it: their records name versions the
 * server no longer holds, the journal's next frames reuse seqs those devices
 * have already read past, and the feed replayed from zero hands them their
 * own yesterday as if it were news. Nothing here guesses. The FEED MARK --
 * the last entry this device processed (`state.ts`) -- is asked for again, and
 * a journal that no longer holds it where it was is a journal that went back.
 *
 * WHAT A WRONG VERDICT COSTS IS REQUESTS, NEVER A PUBLICATION. A verdict only
 * starts the bounded check; each re-send needs its own proof: the server
 * answers `404 unknown_version` for the exact version this device recorded,
 * and still holds versions this device had processed (server time at or
 * before the mark) to name as parents, none of them NEWER than the lost one --
 * a newer one is a version retention pruned under a record this device kept
 * behind on purpose, a refused move or an unselected destination, and
 * re-sending it would put month-old content back over it. A file the server
 * lacks entirely is re-sent only on a proved restore or for a version the
 * server cannot have collected yet (`UNCOLLECTED_MS`). Deletions are re-sent
 * only from a GRAVE, a tombstone this device published or applied; a missing
 * record is never a reason to delete anything.
 *
 * NOTHING WRITTEN AFTER THE RESTORE IS WRITTEN OVER. The parents are the
 * PROCESSED heads, so a head another device posted on the restored server is
 * one side of a fork the ordinary merge and keep-both rules then decide, and
 * the post offers deduplication, so two devices re-sending one lost version
 * publish one.
 *
 * PLATFORM. Requests and vault reads only, through the same transport and
 * `pushFile` as every push: desktop and mobile run it identically, and a file
 * above the mobile ceiling is re-sent the way it was first sent.
 */

import { FeedMark } from "../state";
import { ApiError, ChangeRecord } from "../transport";
import { inFolderScope, inSyncScope } from "../syncScope";
import { VaultPathError } from "../vaultPath";
import type { SyncContext } from "./engine";
import { decodeRecordManifest } from "./pull";
import { Manifest, bury, folderManifest, postManifest, pushFile } from "./push";

/** Reads the check may make: the listing, then two per record not a head. */
export const RESTORE_BUDGET_REQUESTS = 1000;
/** And the time the whole run may take, re-sends included. */
export const RESTORE_BUDGET_MS = 10 * 60 * 1000;

/**
 * A version younger than this cannot have been collected: obsyncd keeps
 * everything younger than `OBSYNC_RETENTION_DAYS`, which is at least one day,
 * and refuses a request signed more than 300 s off its own clock, so this
 * device's clock is that close to the one that stamped the version.
 */
export const UNCOLLECTED_MS = 24 * 60 * 60 * 1000 - 300 * 1000;

export interface Suspicion {
  /** `restored` is proved; `suspected` is a lost version retention may explain. */
  verdict: "restored" | "suspected";
  reason: string;
}

export function young(now: number, ts: number | undefined): boolean {
  return ts !== undefined && now - ts < UNCOLLECTED_MS;
}

/** Was this entry already processed on the timeline the mark ends? */
export function seenBefore(change: Pick<ChangeRecord, "seq" | "ts">, mark: FeedMark): boolean {
  return change.ts < mark.ts || (change.ts === mark.ts && change.seq <= mark.seq);
}

/**
 * Ask the journal whether it still holds the mark where it was: ONE read, and
 * a second only when the mark's own entry is gone. `null` is a journal that
 * agrees. A journal that answers `416`, holds its head behind the cursor,
 * holds another version at the mark's seq, or holds a version where this
 * device read none has been rebuilt -- a live server never reuses a seq. An
 * entry that is simply gone is retention or a restore, and the version itself
 * answers which, when it is too young to have been collected.
 */
export async function probeFeed(context: SyncContext): Promise<Suspicion | null> {
  const { state, transport, host } = context;
  const mark = state.data.feedMark;
  if (mark === null || mark.replay) return null;
  const started = context.now();
  const cursor = state.data.lastSeq;
  let reason: string | null = null;
  let requests = 1;
  try {
    const page = await transport.changes(mark.seq - 1, 0, 2);
    const [first, next] = page.changes;
    if (page.head_seq < cursor) reason = "head_behind";
    else if (first?.seq === mark.seq && first.version_id !== mark.versionId) reason = "mark_replaced";
    else if (first?.seq === mark.seq) reason = next !== undefined && next.seq <= cursor ? "unseen_entry" : null;
    else if (first !== undefined && first.seq <= cursor) reason = "unseen_entry";
    else {
      requests++;
      reason = await transport.getVersion(mark.fileId, mark.versionId).then(() => "mark_moved", (error: unknown) => {
        if (error instanceof ApiError && error.code === "unknown_version") return young(context.now(), mark.ts) ? "mark_lost" : "mark_gone";
        throw error;
      });
    }
  } catch (error) {
    if (!(error instanceof ApiError && error.code === "seq_ahead")) throw error;
    reason = "seq_ahead";
  }
  const verdict = reason === null ? null : reason === "mark_gone" ? "suspected" : "restored";
  host.log(`feed decision=${verdict ?? "verified"}${reason === null ? "" : ` reason=${reason}`} mark_seq=${mark.seq} ` +
    `cursor=${cursor} requests=${requests} duration_ms=${context.now() - started}`);
  return verdict === null ? null : { verdict, reason: reason as string };
}

interface Candidate {
  kind: "file" | "folder" | "tombstone";
  folder: boolean;
  path: string;
  fileId: string;
  versionId: string;
  ts?: number;
}

/**
 * Re-send what a restored server lost, bounded, and say what was decided.
 * Returns how many changes were re-sent. `judged` collects the file ids this
 * run decided, so a repair pass meeting one again does not start another run.
 */
export async function recoverLost(context: SyncContext, suspicion: Suspicion, judged: Set<string>, active: () => boolean): Promise<number> {
  const { state, transport, host } = context;
  const started = context.now();
  const proved = suspicion.verdict === "restored";
  const mark = state.data.feedMark;
  const scope = state.data.syncFolders;
  let requests = 0;
  const spent = (): boolean => !active() || requests >= RESTORE_BUDGET_REQUESTS || context.now() - started > RESTORE_BUDGET_MS;
  host.log(`restore decision=start verdict=${suspicion.verdict} reason=${suspicion.reason} files=${Object.keys(state.data.files).length} ` +
    `graves=${Object.keys(state.data.graves).length} budget_requests=${RESTORE_BUDGET_REQUESTS} budget_ms=${RESTORE_BUDGET_MS}`);

  // Every file's heads: a record naming one is held, and a file id missing
  // from a COMPLETE listing is a file the server lacks entirely.
  const heads = new Map<string, string[]>();
  let after: string | null = null;
  let listed = false;
  while (!spent()) {
    const page = await transport.listFiles(after);
    requests++;
    for (const file of page.files) heads.set(file.file_id, file.heads);
    after = page.next;
    if (after === null) { listed = true; break; }
  }

  const lost: Candidate[] = [];
  const unheld = (fileId: string, versionId: string): boolean => !(heads.get(fileId)?.includes(versionId) ?? false);
  for (const [path, record] of Object.entries(state.data.files)) {
    if (inSyncScope(path, scope) && unheld(record.fileId, record.versionId)) lost.push({ kind: "file", folder: false, path, ...record });
  }
  for (const [path, record] of Object.entries(state.data.folders)) {
    if (inFolderScope(path, scope) && unheld(record.fileId, record.versionId)) lost.push({ kind: "folder", folder: true, path, ...record });
  }
  for (const [fileId, grave] of Object.entries(state.data.graves)) {
    if (unheld(fileId, grave.versionId)) lost.push({ kind: "tombstone", fileId, ...grave });
  }

  const resent = { file: 0, rename: 0, folder: 0, tombstone: 0 };
  const skipped = new Map<string, number>();
  let checked = 0;
  for (const entry of lost) {
    if (spent()) break;
    checked++;
    const outcome = await recoverOne(context, entry, heads, listed, proved, mark, () => requests++);
    judged.add(entry.fileId);
    const done = outcome in resent;
    if (done) resent[outcome as keyof typeof resent]++;
    else skipped.set(outcome, (skipped.get(outcome) ?? 0) + 1);
    host.log(`restore path_class=${entry.kind} decision=${done ? "resent" : "skipped"} reason=${outcome} file=${entry.fileId}`);
  }
  const total = resent.file + resent.rename + resent.folder + resent.tombstone;
  host.log(
    `restore decision=summary verdict=${suspicion.verdict} checked=${checked} resent=${total} notes=${resent.file} ` +
      `renames=${resent.rename} tombstones=${resent.tombstone} folders=${resent.folder} ` +
      [...skipped].map(([why, count]) => `skipped_${why}=${count} `).join("") +
      `unchecked=${lost.length - checked} listed=${listed ? 1 : 0} cut_short=${!listed || checked < lost.length ? 1 : 0} ` +
      `requests=${requests} budget_requests=${RESTORE_BUDGET_REQUESTS} ` +
      `duration_ms=${context.now() - started} budget_ms=${RESTORE_BUDGET_MS}`,
  );
  return total;
}

/** One record or grave: what was re-sent (`file`, `rename`, …), or why not. */
async function recoverOne(
  context: SyncContext,
  entry: Candidate,
  heads: Map<string, string[]>,
  listed: boolean,
  proved: boolean,
  mark: FeedMark | null,
  request: () => void,
): Promise<string> {
  const { transport, host } = context;
  let parents: string[] = [];
  let was: string | null = null;
  if (!heads.has(entry.fileId)) {
    if (!listed) return "unlisted";
    if (entry.kind === "tombstone") return "absent";
    if (!proved && !young(context.now(), entry.ts)) return "absent_unproven";
  } else {
    // THE PROOF: the server says it does not hold this exact version. A
    // version it holds under a newer head is ordinary history.
    request();
    const held = await transport.getVersion(entry.fileId, entry.versionId).then(() => true, (error: unknown) => {
      if (error instanceof ApiError && error.code === "unknown_version") return false;
      throw error;
    });
    if (held) return "held";
    // A folder record carries no time, and is never left behind a later
    // version of its own id: the proved restore alone re-sends it.
    if (entry.kind === "folder" ? !proved : entry.ts === undefined) return "unknown_position";
    request();
    const file = await transport.getFile(entry.fileId);
    const seen = mark === null ? [] : file.versions.filter((version) => version.ts <= mark.ts);
    if (seen.length === 0) return "no_ancestor";
    if (entry.ts !== undefined && seen.some((version) => version.ts > (entry.ts as number))) return "superseded";
    const tops = seen.filter((version) => !seen.some((other) => other.parents.includes(version.version_id)));
    if (entry.kind === "tombstone" && tops.every((version) => version.deleted)) return "already_deleted";
    parents = tops.map((version) => version.version_id);
    // Where the server has the note, which says whether this is a rename.
    // A file's manifest only: a folder's is admitted through a rule with
    // effects of its own (`pull.ts`, `admitFolderRecord`).
    const top = tops[0];
    if (entry.kind === "file" && top !== undefined) {
      was = await decodeRecordManifest(context, { ...top, file_id: entry.fileId, domain_id: file.domain_id })
        .then((manifest) => manifest.path, () => null);
    }
  }
  try {
    if (entry.kind === "file") {
      // A note gone from the vault is the queue's deletion to decide.
      if ((await host.stat(entry.path)) === null) return "pending";
      const outcome = await pushFile(context, entry.path, true, parents);
      if (outcome.status !== "pushed") return "changing";
      context.authored.add(outcome.versionId);
      return was !== null && was !== entry.path ? "rename" : "file";
    }
    const manifest = entry.folder ? folderManifest(context, entry.path, entry.kind === "tombstone") : ({
      v: 1, path: entry.path, size: 0, mtime: context.now(), domain: context.domainId, chunks: [], sha256: "", deleted: true,
    } satisfies Manifest);
    const posted = await postManifest(context, entry.fileId, parents, [], manifest, 0, !entry.folder);
    context.authored.add(posted.versionId);
    if (entry.kind === "folder") context.state.setFolder(entry.path, { fileId: entry.fileId, versionId: posted.versionId });
    else bury(context, entry.fileId, posted.versionId, entry.path, entry.folder);
    await context.state.save();
    return entry.kind;
  } catch (error) {
    if (error instanceof VaultPathError) return "not_synced";
    if (error instanceof ApiError && error.code === "unreachable") throw error;
    return "failed";
  }
}
