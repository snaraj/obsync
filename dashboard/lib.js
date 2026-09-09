// obsync dashboard — pure functions.
//
// Every function here is total, side-effect free, and DOM-free: it is
// imported both by app.js in the browser and by dashboard/test/lib.test.mjs
// under `node --test`. Nothing in this file touches `document`, `window`,
// `fetch`, or the clock; callers pass `now` in so tests are deterministic.
//
// Doctrine: a hostile or absent value must never throw. Every entry point
// coerces, and returns a visible placeholder rather than `undefined`.

/** Placeholder rendered wherever the server gave us nothing usable. */
export const DASH = '—'; // em dash

const BYTE_UNITS = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB', 'EiB'];

/**
 * Binary byte units with one decimal above 1024 B, integers below it.
 * 0 -> "0 B", 1023 -> "1023 B", 1024 -> "1.0 KiB", 1073741824 -> "1.0 GiB".
 * Negative, non-finite, and non-numeric inputs render as the placeholder.
 */
export function formatBytes(n) {
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) return DASH;
  // Floor, not round: bytes are never fractional and 1024 B is "1.0 KiB".
  if (n < 1024) return `${Math.floor(n)} B`;
  let value = n;
  let unit = 0;
  while (value >= 1024 && unit < BYTE_UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  // 1048575 B is 1023.999… KiB, which would round to "1024.0 KiB".
  if (Number(value.toFixed(1)) >= 1024 && unit < BYTE_UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${BYTE_UNITS[unit]}`;
}

/**
 * Device policy ceilings. The protocol spells "no ceiling" as 0
 * (docs/architecture.md 6.2.5: desktop `perFileMaxBytes` 0 = unlimited).
 */
export function formatPolicyBytes(n) {
  if (n === 0) return 'Unlimited';
  return formatBytes(n);
}

const TIME_STEPS = [
  [1000, 60, 'sec'],
  [60000, 60, 'min'],
  [3600000, 24, 'hr'],
  [86400000, 30, 'day'],
  [2592000000, 12, 'mo'],
  [31104000000, Infinity, 'yr'],
];

/**
 * "4 min ago" / "in 4 min" / "just now" / "never".
 * `ts` is unix milliseconds (docs/protocol.md). Falsy or non-finite is
 * "never" — the server sends null for a device that has never signed in.
 */
export function relativeTime(ts, now = Date.now()) {
  if (typeof ts !== 'number' || !Number.isFinite(ts) || ts <= 0) return 'never';
  const delta = now - ts;
  const abs = Math.abs(delta);
  if (abs < 5000) return 'just now';
  for (const [scale, span, name] of TIME_STEPS) {
    const count = Math.floor(abs / scale);
    if (count < span) {
      // Abbreviations stay invariant ("5 min", "3 hr"); only "day" pluralizes.
      const label = name === 'day' && count !== 1 ? 'days' : name;
      return delta < 0 ? `in ${count} ${label}` : `${count} ${label} ago`;
    }
  }
  return 'never';
}

function pad(n, width = 2) {
  return String(n).padStart(width, '0');
}

/**
 * The absolute stamp shown in a `title=` beside every relative time.
 * Deliberately UTC and fixed-format: an operator reading a log line and a
 * device row must be able to line them up without guessing a locale.
 */
export function absoluteTime(ts) {
  if (typeof ts !== 'number' || !Number.isFinite(ts) || ts <= 0) return 'never';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return 'never';
  return (
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} UTC`
  );
}

/** "0 ms", "820 ms", "4.2 s", "3m 07s". */
export function formatDuration(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return DASH;
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)} s`;
  const total = Math.round(ms / 1000);
  return `${Math.floor(total / 60)}m ${pad(total % 60)}s`;
}

/** Thousands separators without a locale dependency. */
export function groupDigits(n) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return DASH;
  const negative = n < 0;
  const digits = String(Math.abs(Math.round(n)));
  let out = '';
  for (let i = 0; i < digits.length; i += 1) {
    if (i > 0 && (digits.length - i) % 3 === 0) out += ',';
    out += digits[i];
  }
  return negative ? `-${out}` : out;
}

/** Fill percentage for a usage bar, clamped to 0..100. */
export function percentOf(used, total) {
  if (typeof used !== 'number' || typeof total !== 'number') return 0;
  if (!Number.isFinite(used) || !Number.isFinite(total) || total <= 0) return 0;
  return Math.min(100, Math.max(0, (used / total) * 100));
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

/**
 * SVG path data for the versions-per-hour sparkline. The baseline is a true
 * zero, not the series minimum, so a flat busy day and a flat idle day do
 * not draw the same line. Empty or unusable input draws nothing ("").
 */
export function sparklinePath(values, width, height) {
  if (!Array.isArray(values) || values.length === 0) return '';
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return '';
  const points = values.map((v) =>
    typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0,
  );
  const max = Math.max(...points);
  const y = (v) => (max === 0 ? height : round2(height - (v / max) * height));
  if (points.length === 1) {
    return `M0,${y(points[0])} L${round2(width)},${y(points[0])}`;
  }
  const step = width / (points.length - 1);
  return points
    .map((v, i) => `${i === 0 ? 'M' : 'L'}${round2(i * step)},${y(v)}`)
    .join(' ');
}

/**
 * The counts out of `overview.activity`, which docs/protocol.md pins as
 * `{"versions_per_hour":[{"hour","count"}]}`, 24 entries oldest first. Only
 * `count` is read: the sparkline's x axis is the hour's position, and the
 * page labels the ends rather than the buckets.
 */
export function versionsPerHour(activity) {
  const raw = activity && Array.isArray(activity.versions_per_hour)
    ? activity.versions_per_hour
    : [];
  return raw.map((entry) => {
    const v = entry && entry.count;
    return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0;
  });
}

/** A throughput budget, e.g. the scrub's `rate_bytes_per_sec`. */
export function formatRate(bytesPerSecond) {
  const bytes = formatBytes(bytesPerSecond);
  return bytes === DASH ? DASH : `${bytes}/s`;
}

const PLATFORMS = {
  ios: ['g-ios', 'iOS'],
  ipados: ['g-ipados', 'iPadOS'],
  android: ['g-android', 'Android'],
  macos: ['g-macos', 'macOS'],
  windows: ['g-windows', 'Windows'],
  linux: ['g-linux', 'Linux'],
};

function platformEntry(platform) {
  const key = typeof platform === 'string' ? platform.trim().toLowerCase() : '';
  return PLATFORMS[key] || null;
}

/** The `<symbol>` id in index.html for a platform, with a generic fallback. */
export function platformGlyphId(platform) {
  const entry = platformEntry(platform);
  return entry ? entry[0] : 'g-device';
}

/** Display casing for a platform code from docs/protocol.md. */
export function platformLabel(platform) {
  const entry = platformEntry(platform);
  if (entry) return entry[1];
  return typeof platform === 'string' && platform.trim() !== '' ? platform.trim() : 'Unknown';
}

/**
 * The double-submit CSRF value: the `obsync_csrf` cookie, echoed back in
 * `X-Obsync-Csrf` on every mutation (docs/protocol.md, admin API). Returns
 * "" when absent so a caller can refuse the mutation rather than send a
 * header the server will reject.
 */
export function csrfToken(cookieString) {
  if (typeof cookieString !== 'string') return '';
  for (const part of cookieString.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== 'obsync_csrf') continue;
    return part.slice(eq + 1).trim();
  }
  return '';
}

const ROUTES = ['overview', 'devices', 'pairing', 'storage', 'install', 'logs'];

/** Hash routing. Anything unknown, empty, or hostile lands on Overview. */
export function routeFromHash(hash) {
  if (typeof hash !== 'string') return 'overview';
  const name = hash.replace(/^#/, '').split('?')[0].trim().toLowerCase();
  return ROUTES.includes(name) ? name : 'overview';
}

export function routes() {
  return ROUTES.slice();
}

/**
 * The sentence under a volume's bar: what the server is doing about this
 * volume's space, in an operator's terms.
 *
 * Three states, and the unverified one wins. A `bytes_used` the server could
 * not re-measure says nothing trustworthy about the watermark, so a page that
 * printed the ordinary threshold sentence beside it would be claiming a
 * comparison the server is itself refusing to make.
 */
export function volumeNote(v) {
  const vol = v && typeof v === 'object' ? v : {};
  if (vol.usage_unverified === true) {
    return 'Usage could not be re-measured: this is the last figure read successfully, and writes are refused until a survey succeeds.';
  }
  const watermark = typeof vol.watermark_bytes === 'number' ? vol.watermark_bytes : null;
  if (watermark === null) return 'Writes are refused below the free-space watermark.';
  return volumeIsLow(vol)
    ? `Below the watermark: writes are refused with 507 until ${formatBytes(watermark)} is free.`
    : `Writes are refused below ${formatBytes(watermark)} free.`;
}

/**
 * Whether a volume's free space has reached its watermark. False when either
 * number is missing: an absent figure is not a full disk.
 */
export function volumeIsLow(v) {
  const vol = v && typeof v === 'object' ? v : {};
  return typeof vol.bytes_free === 'number'
    && typeof vol.watermark_bytes === 'number'
    && vol.bytes_free <= vol.watermark_bytes;
}

/**
 * View rows for the devices table: active devices first, then by last-seen
 * (newest first), then by name, so a revoked device never sits at the top.
 */
export function buildDeviceRows(devices) {
  if (!Array.isArray(devices)) return [];
  const rows = devices.filter((d) => d && typeof d === 'object').map((d) => {
    const policy = d.policy && typeof d.policy === 'object' ? d.policy : {};
    return {
      id: typeof d.device_id === 'string' ? d.device_id : '',
      name: typeof d.name === 'string' && d.name.trim() !== '' ? d.name : '(unnamed)',
      platform: platformLabel(d.platform),
      glyph: platformGlyphId(d.platform),
      appVersion: typeof d.app_version === 'string' && d.app_version ? d.app_version : DASH,
      created: numberOrNull(d.created),
      lastSignIn: numberOrNull(d.last_sign_in),
      lastSeen: numberOrNull(d.last_seen),
      lastEdit: numberOrNull(d.last_edit),
      address: typeof d.address === 'string' && d.address ? d.address : DASH,
      country: typeof d.country === 'string' && d.country ? d.country : DASH,
      perFile: formatPolicyBytes(policy.per_file_max_bytes),
      budget: formatPolicyBytes(policy.total_budget_bytes),
      revoked: d.revoked === true,
      history: Array.isArray(d.history) ? d.history.slice() : [],
    };
  });
  rows.sort((a, b) => {
    if (a.revoked !== b.revoked) return a.revoked ? 1 : -1;
    const seen = (b.lastSeen || 0) - (a.lastSeen || 0);
    if (seen !== 0) return seen;
    return a.name.localeCompare(b.name);
  });
  return rows;
}

function numberOrNull(v) {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null;
}

/**
 * Decision lines for the Logs page: filtered by a device-id prefix and
 * returned newest first. An empty or whitespace prefix keeps everything; a
 * non-empty prefix drops lines with no device.
 */
export function filterLogs(lines, prefix) {
  if (!Array.isArray(lines)) return [];
  const needle = typeof prefix === 'string' ? prefix.trim().toLowerCase() : '';
  const kept = lines.filter((line) => {
    if (!line || typeof line !== 'object') return false;
    // A device-less line has "" as its id: it survives an empty needle and is
    // dropped by any real prefix, with no special case for either.
    const device = typeof line.device === 'string' ? line.device.toLowerCase() : '';
    return device.startsWith(needle);
  });
  kept.sort((a, b) => (Number(b.ts) || 0) - (Number(a.ts) || 0));
  return kept;
}
