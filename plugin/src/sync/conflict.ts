/**
 * Conflict resolution, `docs/architecture.md` 6.2 item 4.
 *
 * Two heads on a text file with a reachable common ancestor get a homegrown
 * three-way line merge; a clean merge becomes a new version with BOTH heads
 * as parents. Anything else — binary content, no common ancestor, delete
 * versus edit, overlapping hunks, or a file too large to align — keeps both
 * sides: the foreign head is written beside the local one as
 * `<name> (conflict from <device>, <YYYY-MM-DD HHmm>).<ext>` and the user is
 * told. obsync never silently discards an edit.
 *
 * The merge is line-based diff3 over an LCS alignment of each side against
 * the base. Alignment cost is bounded: after common prefix and suffix lines
 * are trimmed, the LCS table is refused above `MAX_ALIGN_CELLS`, and the
 * refusal takes the conflict-copy path. A merge that cannot be afforded is
 * not a merge that may be guessed.
 *
 * PLATFORM. Pure string work, identical on desktop and mobile.
 */

/** 4 M cells ≈ 16 MB of Uint32 table: affordable on a phone, and generous for notes. */
export const MAX_ALIGN_CELLS = 4_000_000;

export type MergeOutcome =
  | { ok: true; text: string }
  | { ok: false; reason: "overlap" | "too_large" | "binary" };

function splitLines(text: string): string[] {
  return text.split("\n");
}

function sameLines(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * Longest common subsequence alignment as a base-index → side-index map.
 * Returns `null` when the table would exceed `MAX_ALIGN_CELLS`.
 */
export function alignLines(base: string[], side: string[]): Map<number, number> | null {
  let prefix = 0;
  while (prefix < base.length && prefix < side.length && base[prefix] === side[prefix]) prefix++;
  let suffix = 0;
  while (
    suffix < base.length - prefix &&
    suffix < side.length - prefix &&
    base[base.length - 1 - suffix] === side[side.length - 1 - suffix]
  ) {
    suffix++;
  }
  const map = new Map<number, number>();
  for (let i = 0; i < prefix; i++) map.set(i, i);
  for (let i = 0; i < suffix; i++) map.set(base.length - 1 - i, side.length - 1 - i);

  const rows = base.length - prefix - suffix;
  const columns = side.length - prefix - suffix;
  if (rows <= 0 || columns <= 0) return map;
  if (rows * columns > MAX_ALIGN_CELLS) return null;

  const table = new Uint32Array((rows + 1) * (columns + 1));
  for (let i = rows - 1; i >= 0; i--) {
    for (let j = columns - 1; j >= 0; j--) {
      const here = i * (columns + 1) + j;
      table[here] =
        base[prefix + i] === side[prefix + j]
          ? (table[here + columns + 2] as number) + 1
          : Math.max(table[here + columns + 1] as number, table[here + 1] as number);
    }
  }
  let i = 0;
  let j = 0;
  while (i < rows && j < columns) {
    if (base[prefix + i] === side[prefix + j]) {
      map.set(prefix + i, prefix + j);
      i++;
      j++;
    } else if ((table[(i + 1) * (columns + 1) + j] as number) >= (table[i * (columns + 1) + j + 1] as number)) {
      i++;
    } else {
      j++;
    }
  }
  return map;
}

/**
 * Three-way line merge. `base` is the common ancestor, `mine` the local
 * text, `theirs` the foreign head. A hunk where only one side moved takes
 * that side; a hunk where both sides made the same move takes it once; a
 * hunk where both sides moved differently is a conflict and nothing is
 * merged.
 */
export function threeWayMerge(base: string, mine: string, theirs: string): MergeOutcome {
  const baseLines = splitLines(base);
  const mineLines = splitLines(mine);
  const theirsLines = splitLines(theirs);
  const toMine = alignLines(baseLines, mineLines);
  const toTheirs = alignLines(baseLines, theirsLines);
  if (!toMine || !toTheirs) return { ok: false, reason: "too_large" };

  const anchors: { base: number; mine: number; theirs: number }[] = [];
  for (let i = 0; i < baseLines.length; i++) {
    const m = toMine.get(i);
    const t = toTheirs.get(i);
    if (m !== undefined && t !== undefined) anchors.push({ base: i, mine: m, theirs: t });
  }
  anchors.push({ base: baseLines.length, mine: mineLines.length, theirs: theirsLines.length });

  const out: string[] = [];
  let b = 0;
  let m = 0;
  let t = 0;
  for (const anchor of anchors) {
    const baseHunk = baseLines.slice(b, anchor.base);
    const mineHunk = mineLines.slice(m, anchor.mine);
    const theirsHunk = theirsLines.slice(t, anchor.theirs);
    const mineMoved = !sameLines(mineHunk, baseHunk);
    const theirsMoved = !sameLines(theirsHunk, baseHunk);
    if (mineMoved && theirsMoved && !sameLines(mineHunk, theirsHunk)) {
      return { ok: false, reason: "overlap" };
    }
    out.push(...(mineMoved ? mineHunk : theirsHunk));
    if (anchor.base < baseLines.length) out.push(baseLines[anchor.base] as string);
    b = anchor.base + 1;
    m = anchor.mine + 1;
    t = anchor.theirs + 1;
  }
  return { ok: true, text: out.join("\n") };
}

/**
 * A device name is chosen on another device and therefore untrusted input to
 * a path. Path separators and the characters vaults and filesystems reject go
 * away, runs of dots collapse so no `..` survives, and the result is bounded.
 * The name lands inside a longer name, so no path segment can become `..`.
 */
function sanitiseDeviceName(name: string): string {
  const cleaned = name
    .replace(/[\\/:*?"<>|#^[\]]/g, " ")
    .replace(/\.{2,}/g, ".")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned === "" ? "another device" : cleaned.slice(0, 40);
}

function pad(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

/** `YYYY-MM-DD HHmm` in the device's local time, as the user reads it. */
export function conflictStamp(when: Date): string {
  return (
    `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())} ` +
    `${pad(when.getHours())}${pad(when.getMinutes())}`
  );
}

/**
 * `Notes/Ideas.md` → `Notes/Ideas (conflict from iPhone, 2026-09-07 1432).md`.
 * A name without an extension keeps none; a dotfile keeps its leading dot.
 */
export function conflictCopyPath(path: string, deviceName: string, when: Date): string {
  const slash = path.lastIndexOf("/");
  const folder = slash < 0 ? "" : path.slice(0, slash + 1);
  const name = slash < 0 ? path : path.slice(slash + 1);
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const extension = dot > 0 ? name.slice(dot) : "";
  return `${folder}${stem} (conflict from ${sanitiseDeviceName(deviceName)}, ${conflictStamp(when)})${extension}`;
}

/** Text files are merged; everything else takes the conflict-copy path. */
export function isMergeableText(path: string, bytes: Uint8Array): boolean {
  if (!/\.(md|markdown|txt|csv|json|ya?ml|ts|js|css|html|xml|toml|ini|log)$/i.test(path)) return false;
  for (let i = 0; i < bytes.length; i++) if (bytes[i] === 0) return false;
  return true;
}
