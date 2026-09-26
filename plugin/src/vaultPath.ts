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
  | "nested_vault"
  | "symlink_component"
  | "not_a_directory"
  | "not_a_file"
  | "temp_identity"
  | "target_identity"
  | "chain_changed";

/** Control characters, U+0000 to U+001F and U+007F: NUL truncates a path at the syscall. */
function hasControl(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

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
  if (hasControl(value)) return "control_character";
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

/**
 * Do two vault paths name the same thing in a different CASE, and in nothing
 * else (issue #124)?
 *
 * A host whose filesystem folds case holds ONE directory entry for both, so
 * `Team docs` -> `team docs` is a rename of that entry and never a second
 * file; a host that does not holds two. The plugin cannot ask a path which
 * kind of host it is on, but it can ask whether two paths differ only this
 * way, and the answer decides whether an incoming move is applied as one
 * rename or as a write and a removal that would take the live file with it
 * on a folding host.
 *
 * FOLDING IS CASE AND NOTHING ELSE. The comparison is `toLowerCase`, never
 * `toLocaleLowerCase`: the device locale is a per-device fact and two
 * devices folding one name differently would each believe the other renamed
 * it. Lengths must match, which keeps the two Unicode traps apart from this
 * rule — a name in NFC and the same name in NFD differ in length, and the
 * one-to-many foldings (a dotted capital I, a sharp S) lengthen too. Those
 * are genuine renames of a name this device cannot claim is the same entry,
 * and they take the ordinary path.
 */
export function caseOnly(a: string, b: string): boolean {
  return a !== b && a.length === b.length && a.toLowerCase() === b.toLowerCase();
}

/**
 * The same question asked of the LAST COMPONENT ALONE: do these two paths
 * differ in the capitalisation of their final name, with every directory
 * above it spelled identically (review round 4, finding 2)?
 *
 * A DIFFERENCE IN AN ANCESTOR IS NOT ONE ANY HOST CAN APPLY FROM HERE.
 * `rename(2)` resolves the directory components of its destination and
 * renames only the last, so asking a host to move `Docs/Team docs` to
 * `docs/Team docs` renames the entry onto itself: the call succeeds, the
 * vault still shows the old spelling, and the spelling check refuses it --
 * after this device has already marked echoes and moved records for a rename
 * nothing made. An ancestor of a selected folder is also a folder this device
 * neither publishes nor receives (`syncScope.ts`, `docs/architecture.md`), so
 * the folder rule's case tolerance stops at the last component, which is the
 * only component a re-case of a folder can change.
 */
export function caseOnlyLastComponent(a: string, b: string): boolean {
  const cut = a.lastIndexOf("/");
  return caseOnly(a, b) && a.slice(0, cut + 1) === b.slice(0, cut + 1);
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
