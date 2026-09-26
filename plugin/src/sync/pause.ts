/** Encrypted per-note pause controls (#179); no server change or clear names. */
import { hex, hmacSha256, utf8 } from "../crypto";
import { ApiError } from "../transport";
import type { SyncContext } from "./engine";
import { decodeRecordManifest } from "./pull";
import { postManifest, type PauseManifest } from "./push";

const announced = new WeakSet<object>();

export async function pauseId(context: SyncContext, target: string): Promise<string> {
  return hex((await hmacSha256(context.manifestKey, utf8(`obsync/v1/pause/${target}`))).subarray(0, 16));
}

/** One control record per target; resume replaces all observed control heads. */
export async function publishPause(context: SyncContext, target: string, path: string, paused: boolean): Promise<void> {
  const started = context.now();
  const held = context.state.data.paused[target];
  if (paused && held !== undefined && announced.has(held)) return;
  const fileId = await pauseId(context, target);
  let parents: string[];
  try {
    const file = await context.transport.getFile(fileId);
    parents = file.heads;
    const current = await Promise.all(file.heads.map(async (head) => {
      const version = file.versions.find((entry) => entry.version_id === head);
      return version === undefined ? null : await decodeRecordManifest(context, { ...version, file_id: fileId, domain_id: file.domain_id });
    }));
    if (current.length > 0 && current.every((entry) => entry?.v === 3 && entry.paused === paused)) {
      if (paused && held !== undefined) announced.add(held);
      return;
    }
  }
  catch (error) {
    if (!(error instanceof ApiError) || error.status !== 404) throw error;
    parents = [];
  }
  const manifest: PauseManifest = {
    v: 3, kind: "pause", path, target, paused, domain: context.domainId,
    size: 0, chunks: [], sha256: "", deleted: false,
  };
  const posted = await postManifest(context, fileId, parents, [], manifest, 0, true);
  context.authored.add(posted.versionId);
  if (paused && held !== undefined) announced.add(held);
  context.host.log(`pause decision=published paused=${paused} file=${target} duration_ms=${context.now() - started}`);
}
