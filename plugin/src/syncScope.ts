/** Device-local folder selection. Never part of pairing, the domain map or device policy. */
import { VaultPathError, assertVaultPath, caseOnlyLastComponent, isVaultPath } from "./vaultPath";

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

/**
 * Is this FOLDER one this device publishes and receives a record for?
 *
 * THE SELECTION ROOT IS A FOLDER LIKE ANY OTHER, and that is the difference
 * from `inSyncScope`, which never places a folder inside itself. A folder
 * record IS its path, so the record for the selected folder itself is what
 * carries that folder's creation, its removal and -- the case this rule was
 * written for -- a rename of its capitalisation, which no per-file move can
 * carry because `rename(2)` resolves a destination's directory components
 * (`sync/pull.ts`, `recaseFolder`). Refused at the root, a device whose
 * selection IS the renamed folder published the moves and no record, and
 * every folding receiver refused them with a notice blaming a version
 * problem the pair did not have (review round 3, finding 1).
 *
 * AND ONLY AT THE ROOT. An ANCESTOR of a selected folder is a directory this
 * device may walk (`inSyncTree`) and never one it publishes: a record for it
 * would tell every other device about a folder outside what this one syncs.
 * FILE records keep the strict rule -- a selected folder is a directory,
 * never a file wearing that exact name.
 */
export function inFolderScope(path: unknown, folders: SyncFolders): path is string {
  return isVaultPath(path) && (folders === undefined || folders.some((folder) =>
    path === folder || path.startsWith(`${folder}/`),
  ));
}

export function assertFolderScope(path: unknown, folders: SyncFolders): string {
  const canonical = assertVaultPath(path);
  if (!inFolderScope(canonical, folders)) throw new VaultPathError("outside_sync_scope");
  return canonical;
}

/**
 * The folder rule, plus the ONE spelling a host that folds case cannot tell
 * apart from a selection root.
 *
 * THIS DEVICE'S OWN RENAME, which is what this rule is for on the PUSH side:
 * a device that re-cases the folder it selects moves its selection with the
 * rename, so the tombstone it then publishes for the old spelling names a
 * folder its selection no longer holds (`sync/push.ts`, `main.ts`). Refused
 * by the string rule, that device could not publish its own rename at all:
 * the entry would be re-cased here and nowhere else.
 *
 * WHETHER TWO SPELLINGS REALLY ARE ONE ENTRY IS NOT A QUESTION A STRING CAN
 * ANSWER, so this rule is a string tolerance and never an admission. The
 * tolerance is for a SELECTED ROOT alone and for the capitalisation of its
 * LAST COMPONENT alone (`caseTwinRoot`): a record one component deeper, an
 * ancestor spelled differently, or a difference of anything but case, is
 * another folder.
 *
 * AND THE RECEIVING SIDE NEEDS MORE THAN A STRING. A record one
 * capitalisation off a selected folder is this device's own folder under a
 * new name ONLY when its own record for that folder has just been retired by
 * that folder's tombstone; anything else is a SECOND folder on a device that
 * keeps the two spellings apart, and applying it would move this device's
 * selection onto a folder it never selected (review round 4, finding 1). The
 * feed therefore goes through `sync/pull.ts`, `admitFolderRecord`, which adds
 * that condition to this rule.
 */
export function inFolderCaseScope(path: unknown, folders: SyncFolders): path is string {
  return inFolderScope(path, folders) || caseTwinRoot(path, folders) !== null;
}

/**
 * The selected folder this path is ONE CAPITALISATION OF, or `null`.
 *
 * The last component alone may differ (`vaultPath.ts`,
 * `caseOnlyLastComponent`): an ancestor spelled differently is a rename no
 * host can make from here -- `rename(2)` resolves a destination's directory
 * components -- and an ancestor of a selected folder is a folder this device
 * never publishes and never receives (review round 4, finding 2).
 *
 * The answer is the SELECTED spelling, because that is what the receiving
 * side has to reason about: whether the record names this device's own folder
 * under a new name, or a SECOND folder on a device that keeps the two
 * spellings apart (`sync/pull.ts`, `admitFolderRecord`).
 */
export function caseTwinRoot(path: unknown, folders: SyncFolders): string | null {
  if (!isVaultPath(path) || folders === undefined) return null;
  return folders.find((folder) => caseOnlyLastComponent(folder, path)) ?? null;
}

export function assertFolderCaseScope(path: unknown, folders: SyncFolders): string {
  const canonical = assertVaultPath(path);
  if (!inFolderCaseScope(canonical, folders)) throw new VaultPathError("outside_sync_scope");
  return canonical;
}

/**
 * The selection after a folder rename, and how much of it moved -- or `null`
 * when this rename moves none of it.
 *
 * ONE RULE, TWO CALLERS. The device that MAKES the rename moves its selection
 * with the folder (`sync/engine.ts`), and so must the device that RECEIVES
 * one: a pulled re-case of a selected folder that left the selection at the
 * old spelling would leave the device syncing a folder its own vault no
 * longer shows -- every file under it out of scope in the same tick, which is
 * the scope exit issue #91 refuses to publish and the user's device silently
 * syncing nothing (review round 3, finding 1). Canonicalised by the parser,
 * so a destination inside another selected folder collapses into it rather
 * than being remembered twice, and a destination this device may not select
 * at all raises instead of narrowing the selection silently.
 */
export function selectionAfterRename(
  folders: SyncFolders,
  from: string,
  to: string,
): { folders: string[]; moved: number } | null {
  const moved = movedSelection(folders, from);
  if (folders === undefined || moved.length === 0) return null;
  return {
    folders: parseSyncFolders(folders.map((folder) => (moved.includes(folder) ? to + folder.slice(from.length) : folder))),
    moved: moved.length,
  };
}

/** The selected folders a rename of `from` moves: the folder itself and any beneath it. */
export function movedSelection(folders: SyncFolders, from: string): string[] {
  return folders === undefined ? [] : folders.filter((folder) => folder === from || folder.startsWith(`${from}/`));
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
