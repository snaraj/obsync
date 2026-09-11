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
 * A WALK IS ONLY TRUE WHEN IT WAS TAKEN. The components it approved are
 * names, and a name can be made to mean a different directory a syscall
 * later: rename `Notes` aside, put a symlink to somewhere else in its place,
 * and the very next `open` creates the file there — with the descriptor and
 * a `lstat` of the same name agreeing perfectly, because both now resolve
 * through the swapped parent. `walkVaultPath` therefore records the CHAIN —
 * the vault root and every directory below it, by device and inode — and
 * `chainRefusal` re-checks it after the operation and before the result is
 * used. Identity of the file is not identity of the path to it.
 *
 * THE RESIDUAL WINDOW, STATED PRECISELY. Node exposes no `openat` and no
 * directory-relative open, so the plugin cannot hold a directory descriptor
 * and open through it; every operation goes through a pathname the kernel
 * resolves afresh. Binding the chain across the open closes the window
 * between the walk and the open — the case this was written for — and
 * binding it again across the rename closes the window around the rename.
 * What CANNOT be closed by construction is the instant between a binding
 * and the syscall it guards: an attacker who is already running on the
 * device and can win that race can still redirect a write. That attacker is
 * outside the threat model by design (`docs/threat-model.md`: protecting a
 * device against its own operating system is a stated non-goal), and what
 * IS defended is the case the model does cover — another paired device
 * choosing the path, and anything that got a symlink into the vault before
 * the operation began.
 *
 * PLATFORM. The string rule is identical on desktop and mobile. The root
 * proof, the component walk and the chain binding apply wherever Node's
 * filesystem is used, which is desktop only; mobile reaches the vault
 * exclusively through Obsidian's adapter, which is confined to the vault by
 * the host app.
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
  | "outside_sync_scope"
  | "symlink_component"
  | "not_a_directory"
  | "not_a_file"
  | "temp_identity"
  | "target_identity"
  | "chain_changed";

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
  readonly size: number;
  readonly mtimeMs: number;
}

/** The filesystem seam: a `lstat` that never follows a link, `null` if absent. */
export interface PathWalker {
  lstat(path: string): Promise<PathStat | null>;
}

/** What the walk found at the last component. */
export type FinalComponent = "absent" | "file" | "directory" | "other";

/** One directory on the way down, by the identity only the kernel assigns. */
export interface ChainLink {
  path: string;
  dev: number;
  ino: number;
}

export interface WalkResult {
  target: string;
  final: FinalComponent;
  /** The final component's identity, for a caller that must prove it later. */
  stat: PathStat | null;
  /** The vault root and every directory below it that this path passed through. */
  chain: ChainLink[];
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
  const chain: ChainLink[] = [{ path: base, dev: rootStat.dev, ino: rootStat.ino }];
  const segments = path.split("/");
  let at = base;
  for (let index = 0; index < segments.length; index++) {
    at = node.resolve(at, segments[index] as string);
    const stat = await walker.lstat(at);
    if (stat === null) return { target, final: "absent", stat: null, chain };
    if (stat.isSymbolicLink()) throw new VaultPathError("symlink_component");
    const last = index === segments.length - 1;
    if (!last) {
      if (!stat.isDirectory()) throw new VaultPathError("not_a_directory");
      chain.push({ path: at, dev: stat.dev, ino: stat.ino });
      continue;
    }
    if (stat.isDirectory()) {
      chain.push({ path: at, dev: stat.dev, ino: stat.ino });
      return { target, final: "directory", stat, chain };
    }
    return { target, final: stat.isFile() ? "file" : "other", stat, chain };
  }
  // Unreachable: `vaultTarget` already refused a path with no components.
  throw new VaultPathError("empty");
}

/**
 * Is the chain still the chain the walk saw? Every link must be the same
 * directory BY INODE, not by name: a name can be made to mean a different
 * directory between two syscalls, and that is the whole attack this answers.
 * `null` when nothing moved, otherwise the refusal to raise.
 *
 * A caller binds a chain by walking, doing its one operation, and asking
 * this again before it trusts the result. Inode identity of the FILE is not
 * enough on its own: a file reached through a swapped parent has whatever
 * inode that parent's directory entry points at, including a hard link to
 * the caller's own file.
 */
export async function chainRefusal(
  chain: ChainLink[],
  walker: PathWalker,
): Promise<VaultPathRefusal | null> {
  for (const link of chain) {
    const stat = await walker.lstat(link.path);
    // Most specific cause first: a link in place of a directory is a
    // different fact from a directory that is simply not the one we walked.
    if (stat !== null && stat.isSymbolicLink()) return "symlink_component";
    if (stat === null || !stat.isDirectory()) return "not_a_directory";
    if (stat.dev !== link.dev || stat.ino !== link.ino) return "chain_changed";
  }
  return null;
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
