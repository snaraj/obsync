/**
 * THE DECODER EVERY SHIPPED 1.0.x DEVICE RUNS, vendored so this branch can be
 * tested against it rather than against its own idea of it.
 *
 * WHY A COPY. The compatibility boundary of issue #104 is a claim about code
 * that is ALREADY INSTALLED on about a hundred devices: a folder record must
 * be refused there, not written as a file at the folder's path. Testing that
 * against this branch's decoder would prove nothing — this branch understands
 * folder records. So the released decoder is copied in, verbatim, and the
 * record this branch publishes is fed to it.
 *
 * PROVENANCE, AND HOW TO RE-DERIVE IT. Copied from tag `1.0.4`:
 *
 *   plugin/src/sync/pull.ts
 *     sha256 1574690f33013f4ddedd8e35a44aeca31969043497abed2686cf86ef9d6171a3
 *   plugin/src/vaultPath.ts
 *     sha256 342f68e05cdf1318d3f2e70b2baf3af86d08ea13fc405004516dfb2234efdabc
 *   plugin/src/crypto.ts (`isHex` and `HEX_DIGITS` only)
 *
 *     git show 1.0.4:plugin/src/sync/pull.ts | shasum -a 256
 *     git show 1.0.4:plugin/src/vaultPath.ts | shasum -a 256
 *
 * ONE COPY COVERS EVERY 1.0.x, 1.0.5 and 1.0.6 INCLUDED, which is what makes
 * a copy taken at 1.0.4 the right fixture for every shipped install rather
 * than only for the ones that stopped there (review round 1, finding 4).
 * `parseManifest` is byte-identical at 1.0.0, 1.0.1, 1.0.2, 1.0.3, 1.0.4,
 * 1.0.5 and 1.0.6 —
 * sha256 8aa8a2df240bcd8ffba197fc9b2e238bb9b727ef0416007eb526a3082e8aa4de of
 *
 *     git show <tag>:plugin/src/sync/pull.ts \
 *       | awk '/^export function parseManifest/,/^}/' | shasum -a 256
 *
 * — so the refusal proved here is the refusal every install performs.
 *
 * THE ONLY EDIT. TypeScript annotations are removed, because a test file is
 * not compiled; every statement, every comparison and every refusal string is
 * the released one, in the released order. Nothing here imports from `build/`:
 * a fixture that reached into this branch's own compiled output could not
 * say anything about a device that does not run this branch.
 */

// --- plugin/src/crypto.ts ------------------------------------------------

const HEX_DIGITS = "0123456789abcdef";

export function isHex(text, bytes) {
  if (text.length !== bytes * 2) return false;
  for (let i = 0; i < text.length; i++) {
    if (HEX_DIGITS.indexOf(text[i]) < 0) return false;
  }
  return true;
}

// --- plugin/src/vaultPath.ts ---------------------------------------------

/** Control characters, U+0000 to U+001F and U+007F: NUL truncates a path at the syscall. */
function hasControl(value) {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/** `C:`, `c:/…`: a Windows drive-relative or absolute path. */
const DRIVE = /^[A-Za-z]:/;

/** The reason `value` is not a canonical relative vault path, or `null`. */
export function vaultPathRefusal(value) {
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

// --- plugin/src/sync/pull.ts ---------------------------------------------

/** A decrypted manifest that does not describe a file this device may write. */
export class ManifestError extends Error {
  constructor(reason) {
    super(`manifest refused: ${reason}`);
    this.reason = reason;
    this.name = "ManifestError";
  }
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function size(value) {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

/** A 32-byte identity as lowercase hex: every sid, cid and plaintext digest. */
function digest32(value) {
  return typeof value === "string" && isHex(value, 32);
}

export function parseManifest(json) {
  let value;
  try {
    value = JSON.parse(json);
  } catch {
    throw new ManifestError("not_json");
  }
  if (!isRecord(value)) throw new ManifestError("not_an_object");
  const refusal = vaultPathRefusal(value["path"]);
  if (refusal !== null) throw new ManifestError(`path_${refusal}`);
  if (value["v"] !== 1) throw new ManifestError("version");
  if (!size(value["size"])) throw new ManifestError("size");
  if (typeof value["mtime"] !== "number" || !Number.isFinite(value["mtime"])) throw new ManifestError("mtime");
  if (typeof value["domain"] !== "string") throw new ManifestError("domain");
  if (typeof value["deleted"] !== "boolean") throw new ManifestError("deleted");
  const digest = value["sha256"];
  if (digest !== "" && !digest32(digest)) throw new ManifestError("sha256");
  const chunks = value["chunks"];
  if (!Array.isArray(chunks)) throw new ManifestError("chunks");
  for (const chunk of chunks) {
    if (!isRecord(chunk)) throw new ManifestError("chunk");
    if (!digest32(chunk["sid"])) throw new ManifestError("chunk_sid");
    if (!digest32(chunk["cid"])) throw new ManifestError("chunk_cid");
    if (!size(chunk["len"])) throw new ManifestError("chunk_len");
  }
  return value;
}
