/** Device-local folder selection. Never part of pairing, the domain map or device policy. */
import { VaultPathError, assertVaultPath, isVaultPath } from "./vaultPath";

/** Missing means the existing whole-vault mode; an explicit empty list syncs no files. */
export type SyncFolders = readonly string[] | undefined;

/** Reject an entire malformed selection instead of silently broadening it. */
export function parseSyncFolders(value: unknown): string[] {
  if (!Array.isArray(value)) throw new Error("obsync: sync folders must be a list of relative folder paths; sync is stopped.");
  const folders: string[] = [];
  for (const folder of value as unknown[]) {
    assertVaultPath(folder);
    if ((folder as string).trim() !== folder) throw new VaultPathError("blank_segment");
    if (!folders.includes(folder as string)) folders.push(folder as string);
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

export function expandsSyncScope(before: SyncFolders, after: SyncFolders): boolean {
  if (before === undefined) return false;
  return after === undefined || after.some((folder) => !before.some((old) => folder === old || folder.startsWith(`${old}/`)));
}

export const SCOPE_EXPANSION_MESSAGE =
  "obsync: folders can only be narrowed after this device has synced. " +
  "To sync more local files in this vault, move them into an already selected folder and run Sync now. " +
  "A different folder selection needs a fresh local vault configured before pairing; keep this vault as a backup. " +
  "The selection was not changed.";
