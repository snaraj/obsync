/**
 * Conflict resolution, `docs/architecture.md` 6.2 item 4.
 *
 * Two heads on a text file with a reachable common ancestor are merged
 * character by character, the way collaborative editors combine concurrent
 * keystrokes: each side's change from the base is applied, insertions at one
 * place are both kept, deletions combine, and text one side inserted inside a
 * range the other deleted survives. The merge never refuses text, so typing on
 * one line on two devices never splits a note into a conflict copy. A merge
 * becomes a new version with BOTH heads as parents.
 *
 * Every device computes the same text from the same three inputs, whichever
 * side is its own: insertions at one place are ordered by their content, not
 * by who made them, and an identical insertion lands once. Two devices closing
 * one fork therefore post the same bytes.
 *
 * Conflict copies remain for what has no text merge: binary content, no
 * common ancestor, or a file too large to hold whole. The foreign head is
 * then written beside the local one as
 * `<name> (conflict from <device>, <YYYY-MM-DD HHmm>).<ext>` and the user is
 * told. obsync never silently discards an edit.
 *
 * Alignment cost is bounded. Text spanning lines is aligned by line first:
 * lines that occur once on each side anchor it (patience alignment), Myers'
 * difference algorithm aligns the runs between anchors under a step budget,
 * and each changed run of lines is then aligned by character. A region past
 * every bound is taken whole. A coarser alignment can place an insertion less
 * precisely; it never drops text either side holds.
 *
 * PLATFORM. Pure string work, identical on desktop and mobile.
 */

/** Alignment work per side of one merge: well under a second on a phone. */
export const MERGE_STEPS = 10_000_000;
/** The most differences one alignment explores before a coarser unit is tried. */
const MAX_DISTANCE = 1_000;
/** Characters held as separate tokens at once; longer regions align by line first. */
const CHARACTER_SPAN = 1 << 20;

/** One side's change: `base[from, to)` becomes `insert`. Offsets are UTF-16 units. */
export interface TextChange { from: number; to: number; insert: string }

const isHigh = (unit: number): boolean => unit >= 0xd800 && unit <= 0xdbff;
const isLow = (unit: number): boolean => unit >= 0xdc00 && unit <= 0xdfff;

/**
 * Myers' O(ND) alignment: matched token index pairs in order, or null past
 * `MAX_DISTANCE` differences or the step budget.
 */
function align(a: readonly string[], b: readonly string[], budget: { steps: number }): [number, number][] | null {
  const n = a.length, m = b.length, mid = MAX_DISTANCE + 1;
  const v = new Int32Array(2 * MAX_DISTANCE + 3);
  const trace: Int32Array[] = [];
  for (let d = 0; d <= MAX_DISTANCE; d++) {
    trace.push(v.slice(mid - d - 1, mid + d + 2));
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && (v[mid + k - 1] as number) < (v[mid + k + 1] as number))
        ? v[mid + k + 1] as number : (v[mid + k - 1] as number) + 1;
      let y = x - k;
      const from = x;
      while (x < n && y < m && a[x] === b[y]) { x++; y++; }
      budget.steps -= x - from + 1;
      v[mid + k] = x;
      if (x >= n && y >= m) return backtrack(trace, n, m);
      if (budget.steps < 0) return null;
    }
  }
  return null;
}

function backtrack(trace: readonly Int32Array[], n: number, m: number): [number, number][] {
  const pairs: [number, number][] = [];
  let x = n, y = m;
  for (let d = trace.length - 1; d >= 0; d--) {
    const v = trace[d] as Int32Array, at = (k: number): number => v[k + d + 1] as number;
    const k = x - y;
    const before = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1;
    const px = at(before), py = px - before;
    while (x > px && y > py) pairs.push([--x, --y]);
    if (d > 0) { x = px; y = py; }
  }
  return pairs.reverse();
}

/** Lines with their line feeds, so the tokens join back into the text. */
function lineTokens(text: string): string[] {
  return text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

/** Nesting of anchored runs inside anchored runs; deeper runs align by Myers alone. */
const ANCHOR_DEPTH = 32;

/**
 * Patience alignment of lines: equal ends match, lines occurring once on each
 * side and in the same order anchor the rest, and each run between anchors is
 * aligned the same way, or by Myers when it has no anchor of its own. A run
 * Myers cannot afford stays unmatched, so it is one change.
 */
function alignLines(
  a: readonly string[], a0: number, a1: number, b: readonly string[], b0: number, b1: number,
  budget: { steps: number }, out: [number, number][], depth = 0,
): void {
  while (a0 < a1 && b0 < b1 && a[a0] === b[b0]) out.push([a0++, b0++]);
  const tail: [number, number][] = [];
  while (a0 < a1 && b0 < b1 && a[a1 - 1] === b[b1 - 1]) tail.push([--a1, --b1]);
  if (a0 < a1 && b0 < b1) {
    const anchors = depth < ANCHOR_DEPTH ? uniqueAnchors(a, a0, a1, b, b0, b1) : [];
    if (anchors.length === 0) {
      for (const [i, j] of align(a.slice(a0, a1), b.slice(b0, b1), budget) ?? []) out.push([a0 + i, b0 + j]);
    } else {
      for (const [i, j] of anchors) {
        alignLines(a, a0, i, b, b0, j, budget, out, depth + 1);
        out.push([i, j]);
        a0 = i + 1;
        b0 = j + 1;
      }
      alignLines(a, a0, a1, b, b0, b1, budget, out, depth + 1);
    }
  }
  for (let k = tail.length - 1; k >= 0; k--) out.push(tail[k] as [number, number]);
}

/** Lines once on each side, as the longest run in the same order on both. */
function uniqueAnchors(
  a: readonly string[], a0: number, a1: number, b: readonly string[], b0: number, b1: number,
): [number, number][] {
  const seen = new Map<string, { a: number; b: number; at: number }>();
  for (let i = a0; i < a1; i++) {
    const entry = seen.get(a[i] as string);
    if (entry === undefined) seen.set(a[i] as string, { a: 1, b: 0, at: -1 });
    else entry.a++;
  }
  for (let j = b0; j < b1; j++) {
    const entry = seen.get(b[j] as string);
    if (entry !== undefined) { entry.b++; entry.at = j; }
  }
  const pairs: [number, number][] = [];
  for (let i = a0; i < a1; i++) {
    const entry = seen.get(a[i] as string) as { a: number; b: number; at: number };
    if (entry.a === 1 && entry.b === 1) pairs.push([i, entry.at]);
  }
  // Longest increasing run of `b` positions, by patience sorting.
  const piles: number[] = [], previous = new Int32Array(pairs.length).fill(-1);
  for (let k = 0; k < pairs.length; k++) {
    const j = (pairs[k] as [number, number])[1];
    let low = 0, high = piles.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if ((pairs[piles[middle] as number] as [number, number])[1] < j) low = middle + 1;
      else high = middle;
    }
    if (low > 0) previous[k] = piles[low - 1] as number;
    piles[low] = k;
  }
  const run: [number, number][] = [];
  for (let k = piles.length > 0 ? piles[piles.length - 1] as number : -1; k >= 0; k = previous[k] as number) {
    run.push(pairs[k] as [number, number]);
  }
  return run.reverse();
}

/** Hand each unmatched run of an alignment, with its base offset, to `gap`. */
function gaps(
  a: readonly string[], b: readonly string[], pairs: readonly [number, number][], offset: number,
  gap: (before: string, after: string, at: number) => void,
): void {
  let i = 0, j = 0, at = offset;
  for (const [pi, pj] of [...pairs, [a.length, b.length] as [number, number]]) {
    if (pi > i || pj > j) {
      const removed = a.slice(i, pi).join("");
      gap(removed, b.slice(j, pj).join(""), at);
      at += removed.length;
    }
    if (pi < a.length) at += (a[pi] as string).length;
    i = pi + 1;
    j = pj + 1;
  }
}

/** Align by line when the region spans lines, then each changed run by character. */
function refine(before: string, after: string, at: number, budget: { steps: number }, out: TextChange[]): void {
  if (before !== "" && after !== "" && (before.includes("\n") || after.includes("\n"))) {
    const a = lineTokens(before), b = lineTokens(after), pairs: [number, number][] = [];
    alignLines(a, 0, a.length, b, 0, b.length, budget, pairs);
    gaps(a, b, pairs, at, (x, y, here) => characters(x, y, here, budget, out));
  } else characters(before, after, at, budget, out);
}

function characters(before: string, after: string, at: number, budget: { steps: number }, out: TextChange[]): void {
  if (before !== "" && after !== "" && before.length + after.length <= CHARACTER_SPAN) {
    const a = Array.from(before), b = Array.from(after);
    const pairs = align(a, b, budget);
    if (pairs !== null) {
      gaps(a, b, pairs, at, (x, y, here) => out.push({ from: here, to: here + x.length, insert: y }));
      return;
    }
  }
  out.push({ from: at, to: at + before.length, insert: after });
}

/**
 * The changes that turn `before` into `after`, in `before`'s offsets: sorted,
 * separated by unchanged text, and never splitting a surrogate pair.
 */
export function textChanges(before: string, after: string): TextChange[] {
  if (before === after) return [];
  const shorter = Math.min(before.length, after.length);
  let head = 0;
  while (head < shorter && before.charCodeAt(head) === after.charCodeAt(head)) head++;
  if (head > 0 && isHigh(before.charCodeAt(head - 1))) head--;
  let tail = 0;
  while (tail < shorter - head &&
    before.charCodeAt(before.length - 1 - tail) === after.charCodeAt(after.length - 1 - tail)) tail++;
  if (tail > 0 && isLow(before.charCodeAt(before.length - tail))) tail--;
  const out: TextChange[] = [];
  refine(before.slice(head, before.length - tail), after.slice(head, after.length - tail), head, { steps: MERGE_STEPS }, out);
  return out;
}

/**
 * Three-way character merge. `base` is the common ancestor; `mine` and
 * `theirs` are the two heads, in either order: the result is the same. Each
 * base character survives unless either side deleted it, and every inserted
 * run survives at its place. Two different insertions at one place are
 * ordered by content. An insertion that begins the other side's insertion at
 * the same place lands once: that is one typed stream seen at two lengths,
 * which a base older than both heads' shared text presents twice.
 */
export function mergeText(base: string, mine: string, theirs: string): string {
  return merge(base, mine, theirs).text;
}

/**
 * `mergeText`, also saying whether both sides changed one place differently:
 * different insertions at one place, or a change inside text the other side
 * deleted. That is how two people typing together meet, and the merge keeps
 * both. Two plugins rewriting one value meet the same way, and their values
 * joined are no value at all, so the caller holds an automatic answer instead.
 */
export function merge(base: string, mine: string, theirs: string): { text: string; contested: boolean } {
  if (mine === theirs || theirs === base) return { text: mine, contested: false };
  if (mine === base) return { text: theirs, contested: false };
  const left = textChanges(base, mine), right = textChanges(base, theirs);
  const out: string[] = [];
  let l = 0, r = 0, done = 0, deleter: TextChange[] | null = null, contested = false;
  while (l < left.length || r < right.length) {
    const at = Math.min(left[l]?.from ?? Infinity, right[r]?.from ?? Infinity);
    if (at > done) {
      out.push(base.slice(done, at));
      done = at;
    }
    const x = left[l]?.from === at ? left[l++] : undefined;
    const y = right[r]?.from === at ? right[r++] : undefined;
    if (at < done && ((x !== undefined && deleter !== left) || (y !== undefined && deleter !== right))) contested = true;
    const one = x?.insert ?? "", two = y?.insert ?? "";
    if (two.startsWith(one)) out.push(two);
    else if (one.startsWith(two)) out.push(one);
    else {
      contested = true;
      out.push(one < two ? one + two : two + one);
    }
    const end = Math.max(x?.to ?? at, y?.to ?? at);
    if (end > done) {
      done = end;
      deleter = (x?.to ?? at) >= (y?.to ?? at) && x !== undefined ? left : right;
    }
  }
  out.push(base.slice(done));
  return { text: out.join(""), contested };
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

/**
 * `YYYY-MM-DD HHmm` in the device's local time, as the user reads it -- or in
 * UTC, for a name every device must compute alike wherever it is.
 */
export function conflictStamp(when: Date, utc = false): string {
  return utc
    ? `${when.getUTCFullYear()}-${pad(when.getUTCMonth() + 1)}-${pad(when.getUTCDate())} ` +
        `${pad(when.getUTCHours())}${pad(when.getUTCMinutes())} UTC`
    : `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())} ` +
        `${pad(when.getHours())}${pad(when.getMinutes())}`;
}

/**
 * `Notes/Ideas.md` → `Notes/Ideas (conflict from iPhone, 2026-09-07 1432).md`.
 * A name without an extension keeps none; a dotfile keeps its leading dot.
 *
 * The stamp is minute-resolution, so two versions kept in the same minute
 * derive the SAME name. `attempt` is how the caller asks for another one —
 * `… ) 2.md`, `… ) 3.md` — because the second copy must never be written over
 * the first: the first may already hold edits of the user's that nothing else
 * has (issue #98, review round 1). Attempt 1 is the plain name, so a vault
 * that never collides never grows an ordinal.
 */
export function conflictCopyPath(
  path: string,
  deviceName: string,
  when: Date,
  attempt = 1,
  stamp = conflictStamp(when),
): string {
  const slash = path.lastIndexOf("/");
  const folder = slash < 0 ? "" : path.slice(0, slash + 1);
  const name = slash < 0 ? path : path.slice(slash + 1);
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const extension = dot > 0 ? name.slice(dot) : "";
  const ordinal = attempt > 1 ? ` ${attempt}` : "";
  return `${folder}${stem} (conflict from ${sanitiseDeviceName(deviceName)}, ${stamp})${ordinal}${extension}`;
}

/** Text files are merged; everything else takes the conflict-copy path. */
export function isMergeableText(path: string, bytes: Uint8Array): boolean {
  if (!/\.(md|markdown|txt|csv|json|ya?ml|ts|js|css|html|xml|toml|ini|log)$/i.test(path)) return false;
  for (let i = 0; i < bytes.length; i++) if (bytes[i] === 0) return false;
  return true;
}
