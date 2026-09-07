/**
 * The one vault-path rule, and the desktop vault-root proof.
 *
 * A decrypted manifest is DATA FROM ANOTHER DEVICE, not an instruction. Its
 * `path` decides where bytes land, so a compromised or hostile paired device
 * that can post a valid encrypted manifest could otherwise name
 * `../../outside-the-vault.md`, an absolute path, or this plugin's own
 * `.obsidian/plugins/obsync/main.js` and have the writer put its bytes there.
 * Every vault operation — read, write, rename, trash, conflict copy,
 * remote-only listing, watcher ingestion, manifest decode — goes through
 * `vaultPathRefusal` first (`docs/architecture.md` 6.2 item 3).
 *
 * A canonical relative vault path is: a non-empty string; no leading `/` and
 * no drive letter; no backslash; no NUL or other control character; and every
 * `/`-separated segment non-empty, not `.`, not `..`, not whitespace only,
 * and not starting with `.`.
 *
 * HIDDEN SEGMENTS ARE EXCLUDED IN BOTH DIRECTIONS IN v0.1. That rule takes
 * `.obsidian/**` — including this plugin's own bundle, its `data.json` and
 * therefore the vault key — and `.git/**` out of sync entirely: they are
 * neither pushed nor accepted. Syncing hidden folders is a later opt-in with
 * its own design (a plugin that can rewrite its own code from the feed is a
 * remote-code-execution channel between devices), not a setting to add here.
 *
 * The string rule is not the last line on desktop. `vaultTarget` resolves the
 * absolute target and proves it stays STRICTLY below the vault root, so a
 * caller that forgets the string rule still cannot write outside the vault.
 * It takes the resolver as a parameter because Node's `path` exists only on
 * desktop; `main.ts` passes it, and nothing under `plugin/src` imports Node.
 *
 * A STRING PROOF IS NOT A FILESYSTEM PROOF. `path.resolve` is lexical: it
 * knows nothing about what the components ARE. A directory symlink already
 * inside the vault — `Linked` → somewhere else — passes every string check
 * and then `mkdir`, `open` and `rename` follow it, which is how a manifest
 * for `Linked/from-remote.md` wrote outside the vault. `walkVaultPath`
 * therefore stats every component from the vault root down WITHOUT following
 * links: each one must be a real directory, never a symlink, and the final
 * component must be absent, a regular file, or a real directory as the
 * operation requires. SYMLINKED FOLDERS ARE NOT SYNCED IN v0.1, in either
 * direction: the watcher and startup reconciliation skip them the same way
 * they skip hidden folders, and lifting that is a later opt-in with its own
 * design, not a setting.
 *
 * PLATFORM. The string rule is identical on desktop and mobile. The root
 * proof and the component walk apply wherever Node's filesystem is used,
 * which is desktop only; mobile reaches the vault exclusively through
 * Obsidian's adapter, which is confined to the vault by the host app.
 */

export type VaultPathRefusal =
  | "not_a_string"
  | "empty"
  | "absolute"
  | "drive_letter"
  | "backslash"
  | "control_character"
  | "empty_segment"
  | "dot_segment"
  | "blank_segment"
  | "hidden_segment"
  | "outside_root"
  | "symlink_component"
  | "not_a_directory"
  | "not_a_file"
  | "temp_identity"
  | "target_identity";

/** Control characters, including NUL, which truncates a path at the syscall. */
const CONTROL = /[\u0000-\u001f\u007f]/;

/** `C:`, `c:/…`: a Windows drive-relative or absolute path. */
const DRIVE = /^[A-Za-z]:/;

export class VaultPathError extends Error {
  constructor(readonly refusal: VaultPathRefusal) {
    // The path itself is untrusted text and stays out of the message, the
    // way every log line in the plugin keeps paths out (requirement 6).
    super(`refused: not a vault path (${refusal})`);
    this.name = "VaultPathError";
  }
}

/** The reason `value` is not a canonical relative vault path, or `null`. */
export function vaultPathRefusal(value: unknown): VaultPathRefusal | null {
  if (typeof value !== "string") return "not_a_string";
  if (value === "") return "empty";
  if (value.includes("\\")) return "backslash";
  if (CONTROL.test(value)) return "control_character";
  if (value.startsWith("/")) return "absolute";
  if (DRIVE.test(value)) return "drive_letter";
  for (const segment of value.split("/")) {
    if (segment === "") return "empty_segment";
    if (segment === "." || segment === "..") return "dot_segment";
    if (segment.trim() === "") return "blank_segment";
    if (segment.startsWith(".")) return "hidden_segment";
  }
  return null;
}

export function isVaultPath(value: unknown): value is string {
  return vaultPathRefusal(value) === null;
}

/** The same rule, as a refusal. Every vault operation calls this or the above. */
export function assertVaultPath(value: unknown): string {
  const refusal = vaultPathRefusal(value);
  if (refusal !== null) throw new VaultPathError(refusal);
  return value as string;
}

/** Node's `path`, narrowed to what the root proof uses. */
export interface PathResolver {
  resolve(...parts: string[]): string;
  readonly sep: string;
}

/**
 * The absolute filesystem target of a vault-relative path, proven to be
 * strictly below the vault root: the resolved target must start with the
 * resolved root plus a separator, and must not BE the root. This is the
 * second, independent layer — it does not re-apply the string rule, so that
 * removing it is a mutation the tests can see.
 */
export function vaultTarget(root: string, path: string, node: PathResolver): string {
  const base = node.resolve(root);
  const prefix = base.endsWith(node.sep) ? base : base + node.sep;
  const target = node.resolve(base, path);
  if (!target.startsWith(prefix) || target.length <= prefix.length) {
    throw new VaultPathError("outside_root");
  }
  return target;
}

/** What a no-follow stat says about one path component. */
export interface PathStat {
  isDirectory(): boolean;
  isFile(): boolean;
  isSymbolicLink(): boolean;
  readonly dev: number;
  readonly ino: number;
}

/** The filesystem seam: a `lstat` that never follows a link, `null` if absent. */
export interface PathWalker {
  lstat(path: string): Promise<PathStat | null>;
}

/** What the walk found at the last component. */
export type FinalComponent = "absent" | "file" | "directory" | "other";

export interface WalkResult {
  target: string;
  final: FinalComponent;
  /** The final component's identity, for a caller that must prove it later. */
  stat: PathStat | null;
}

/**
 * The filesystem layer of confinement: `vaultTarget` first, then one
 * no-follow stat per component from the vault root down.
 *
 * Every component that exists must be a real directory and must not be a
 * symlink; the last one may also be absent or a regular file, and the caller
 * decides which of those its operation allows. A component that is absent
 * ends the walk — nothing below an absent directory can exist — so a create
 * is free to make what is missing and walk again.
 *
 * This is the check the string proof cannot make: `path.resolve` collapses
 * `..` in the STRING, while the kernel resolves symlinks in the FILESYSTEM,
 * and only one of those two decides where a write lands.
 */
export async function walkVaultPath(
  root: string,
  path: string,
  node: PathResolver,
  walker: PathWalker,
): Promise<WalkResult> {
  const target = vaultTarget(root, path, node);
  const base = node.resolve(root);
  const rootStat = await walker.lstat(base);
  if (rootStat === null || !rootStat.isDirectory()) throw new VaultPathError("not_a_directory");
  if (rootStat.isSymbolicLink()) throw new VaultPathError("symlink_component");
  const segments = path.split("/");
  let at = base;
  for (let index = 0; index < segments.length; index++) {
    at = node.resolve(at, segments[index] as string);
    const stat = await walker.lstat(at);
    if (stat === null) return { target, final: "absent", stat: null };
    if (stat.isSymbolicLink()) throw new VaultPathError("symlink_component");
    const last = index === segments.length - 1;
    if (!last) {
      if (!stat.isDirectory()) throw new VaultPathError("not_a_directory");
      continue;
    }
    if (stat.isDirectory()) return { target, final: "directory", stat };
    return { target, final: stat.isFile() ? "file" : "other", stat };
  }
  // Unreachable: `vaultTarget` already refused a path with no components.
  throw new VaultPathError("empty");
}

/** Do two no-follow stats describe the same file? */
export function sameFile(a: PathStat | null, b: PathStat | null): boolean {
  return (
    a !== null &&
    b !== null &&
    a.isFile() &&
    b.isFile() &&
    !a.isSymbolicLink() &&
    !b.isSymbolicLink() &&
    a.dev === b.dev &&
    a.ino === b.ino
  );
}
