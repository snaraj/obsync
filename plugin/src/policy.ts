/**
 * Device policy, `docs/architecture.md` 6.2 item 5.
 *
 * A ceiling is device policy, never a server limit (AGENTS.md requirement 8:
 * the server has no fixed size limit). Every value here is shown in the
 * settings tab and reported to the server by the heartbeat so the dashboard's
 * device table can show it.
 *
 * PLATFORM.
 * - Desktop (Electron): `perFileMaxBytes = 0`, meaning unlimited — the
 *   desktop path streams 8 MiB windows through Node's `fs` and never holds a
 *   whole file.
 * - Mobile (iOS, iPadOS, Android): `perFileMaxBytes = 512 MiB`, the
 *   practical whole-file read ceiling in a WebView, and
 *   `totalBudgetBytes = 50 GiB` by owner ruling.
 *
 * A file above a ceiling is never downloaded automatically; it is listed in
 * the "Remote only" view with an on-demand fetch, so nothing is silently
 * lost. Files are never SKIPPED on upload by policy: refusing to store a
 * file the user actually created would lose data.
 */

export interface Policy {
  /** Largest file this device downloads automatically. 0 = unlimited. */
  perFileMaxBytes: number;
  /** Largest total this device keeps locally. 0 = unlimited. */
  totalBudgetBytes: number;
}

export const MIB = 1 << 20;
export const GIB = 1024 * MIB;

export const DESKTOP_POLICY: Policy = { perFileMaxBytes: 0, totalBudgetBytes: 0 };
export const MOBILE_POLICY: Policy = { perFileMaxBytes: 512 * MIB, totalBudgetBytes: 50 * GIB };

export function defaultPolicy(isMobile: boolean): Policy {
  return isMobile ? { ...MOBILE_POLICY } : { ...DESKTOP_POLICY };
}

export type Admission = { ok: true } | { ok: false; reason: "per_file" | "budget" };

/**
 * May this device materialise a `size`-byte file locally, given `usedBytes`
 * already held? A ceiling of 0 is unlimited. Called before every download,
 * never before an upload.
 */
export function admit(policy: Policy, usedBytes: number, size: number): Admission {
  if (policy.perFileMaxBytes > 0 && size > policy.perFileMaxBytes) {
    return { ok: false, reason: "per_file" };
  }
  if (policy.totalBudgetBytes > 0 && usedBytes + size > policy.totalBudgetBytes) {
    return { ok: false, reason: "budget" };
  }
  return { ok: true };
}

/** Human text for a refusal, shown in the "Remote only" view and the log line. */
export function admissionReason(policy: Policy, reason: "per_file" | "budget"): string {
  return reason === "per_file"
    ? `above this device's per-file ceiling (${formatBytes(policy.perFileMaxBytes)})`
    : `above this device's total budget (${formatBytes(policy.totalBudgetBytes)})`;
}

export function formatBytes(bytes: number): string {
  if (bytes === 0) return "unlimited";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  const rounded = value >= 100 || unit === 0 ? Math.round(value) : Math.round(value * 10) / 10;
  return `${rounded} ${units[unit]}`;
}

/**
 * The inverse of `formatBytes` for the settings fields: accepts a plain byte
 * count, a unit form such as `512 MiB`, and the word `unlimited`. Returns
 * `null` for anything it cannot read, so a half-typed value never silently
 * becomes a ceiling of zero.
 */
export function parseBytes(text: string): number | null {
  const trimmed = text.trim().toLowerCase();
  if (trimmed === "" ) return null;
  if (trimmed === "unlimited" || trimmed === "0") return 0;
  const match = /^(\d+(?:\.\d+)?)\s*(b|kib|mib|gib|tib)?$/.exec(trimmed);
  if (!match) return null;
  const scale = { b: 1, kib: 1024, mib: MIB, gib: GIB, tib: 1024 * GIB }[match[2] ?? "b"] ?? 1;
  return Math.round(Number(match[1]) * scale);
}

/** Bytes this device currently holds, summed from the file state. */
export function localBytes(sizes: Iterable<number>): number {
  let total = 0;
  for (const size of sizes) total += size;
  return total;
}
