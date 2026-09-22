/** Device-local folder selection. Never part of pairing, the domain map or device policy. */
import { VaultPathError, assertVaultPath, isVaultPath } from "./vaultPath";

/** Missing means the existing whole-vault mode; an explicit empty list syncs no files. */
export type SyncFolders = readonly string[] | undefined;

/** Reject an entire malformed selection instead of silently broadening it. */
export function parseSyncFolders(value: unknown): string[] {
  if (!Array.isArray(value)) throw new Error("obsync: sync folders must be a list of relative folder paths; sync is stopped.");
  const folders: string[] = [];
  for (const entry of value as unknown[]) {
    const folder = assertVaultPath(entry);
    if (folder.trim() !== folder) throw new VaultPathError("blank_segment");
    if (!folders.includes(folder)) folders.push(folder);
  }
  // A parent already covers its descendants; one representation makes scope comparisons exact.
  return folders.filter((folder) => !folders.some((parent) => parent !== folder && folder.startsWith(`${parent}/`))).sort();
}

/** A selected folder is a directory, never a file with that exact name. */
export function inSyncScope(path: unknown, folders: SyncFolders): path is string {
  return isVaultPath(path) && (folders === undefined || folders.some((folder) => path.startsWith(`${folder}/`)));
}

export function assertSyncPath(path: unknown, folders: SyncFolders): string {
  const canonical = assertVaultPath(path);
  if (!inSyncScope(canonical, folders)) throw new VaultPathError("outside_sync_scope");
  return canonical;
}

/** Directory walks may touch the selected root and its ancestors, never an unrelated subtree. */
export function inSyncTree(path: unknown, folders: SyncFolders): path is string {
  return isVaultPath(path) && (folders === undefined || folders.some((folder) =>
    path === folder || path.startsWith(`${folder}/`) || folder.startsWith(`${path}/`),
  ));
}

/**
 * Does `after` cover anything `before` did not? A widening is what makes the
 * device replay the feed it skipped, so the newly covered remote files arrive
 * (`main.ts`); a narrowing keeps its cursor.
 */
export function expandsSyncScope(before: SyncFolders, after: SyncFolders): boolean {
  if (before === undefined) return false;
  return after === undefined || after.some((folder) => !before.some((old) => folder === old || folder.startsWith(`${old}/`)));
}
