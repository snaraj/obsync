// Tests for every export of dashboard/lib.js.
//
//   node --test dashboard/test/
//
// stdlib only, hand-written expectations, no assertion library
// (AGENTS.md, "Testing doctrine"). `lib.js` carries no package.json beside
// it; Node resolves it as ESM by module-syntax detection, which is why the
// import below works from an .mjs test without a manifest.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DASH,
  absoluteTime,
  buildDeviceRows,
  csrfToken,
  filterLogs,
  formatBytes,
  formatDuration,
  formatPolicyBytes,
  formatRate,
  groupDigits,
  percentOf,
  platformGlyphId,
  platformLabel,
  relativeTime,
  routeFromHash,
  routes,
  sparklinePath,
  versionsPerHour,
  volumeIsLow,
  volumeNote,
} from '../lib.js';

const KiB = 1024;
const MiB = 1024 * KiB;
const GiB = 1024 * MiB;

test('formatBytes: binary units, one decimal above a kibibyte', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(1), '1 B');
  assert.equal(formatBytes(1023), '1023 B');
  assert.equal(formatBytes(1024), '1.0 KiB');
  assert.equal(formatBytes(1536), '1.5 KiB');
  assert.equal(formatBytes(MiB), '1.0 MiB');
  assert.equal(formatBytes(GiB), '1.0 GiB');
  assert.equal(formatBytes(250 * GiB), '250.0 GiB');
  assert.equal(formatBytes(1024 * GiB), '1.0 TiB');
});

test('formatBytes: never rounds up into a stale unit', () => {
  // 1048575 B is 1023.999… KiB and must not render as "1024.0 KiB".
  assert.equal(formatBytes(MiB - 1), '1.0 MiB');
  assert.equal(formatBytes(GiB - 1), '1.0 GiB');
  assert.equal(formatBytes(KiB - 0.4), '1023 B');
});

test('formatBytes: hostile input renders the placeholder', () => {
  assert.equal(formatBytes(-1), DASH);
  assert.equal(formatBytes(NaN), DASH);
  assert.equal(formatBytes(Infinity), DASH);
  assert.equal(formatBytes(undefined), DASH);
  assert.equal(formatBytes(null), DASH);
  assert.equal(formatBytes('1024'), DASH);
});

test('formatPolicyBytes: zero is the protocol spelling of unlimited', () => {
  assert.equal(formatPolicyBytes(0), 'Unlimited');
  assert.equal(formatPolicyBytes(512 * MiB), '512.0 MiB');
  assert.equal(formatPolicyBytes(50 * GiB), '50.0 GiB');
  assert.equal(formatPolicyBytes(undefined), DASH);
});

test('relativeTime: past', () => {
  const now = 1757200000000;
  assert.equal(relativeTime(now, now), 'just now');
  assert.equal(relativeTime(now - 4999, now), 'just now');
  assert.equal(relativeTime(now - 30000, now), '30 sec ago');
  assert.equal(relativeTime(now - 4 * 60000, now), '4 min ago');
  assert.equal(relativeTime(now - 90 * 60000, now), '1 hr ago');
  assert.equal(relativeTime(now - 25 * 3600000, now), '1 day ago');
  assert.equal(relativeTime(now - 3 * 86400000, now), '3 days ago');
  assert.equal(relativeTime(now - 60 * 86400000, now), '2 mo ago');
  assert.equal(relativeTime(now - 400 * 86400000, now), '1 yr ago');
});

test('relativeTime: future timestamps read forwards, not negatively', () => {
  const now = 1757200000000;
  assert.equal(relativeTime(now + 3000, now), 'just now');
  assert.equal(relativeTime(now + 4 * 60000, now), 'in 4 min');
  assert.equal(relativeTime(now + 2 * 86400000, now), 'in 2 days');
});

test('relativeTime: absent stamps say never', () => {
  assert.equal(relativeTime(null, 1), 'never');
  assert.equal(relativeTime(undefined, 1), 'never');
  assert.equal(relativeTime(0, 1), 'never');
  assert.equal(relativeTime(-5, 1), 'never');
  assert.equal(relativeTime(NaN, 1), 'never');
  assert.equal(relativeTime('1757200000000', 1), 'never');
});

test('absoluteTime: fixed UTC format for the title attribute', () => {
  // Cross-checked against `new Date(1757200000000).toISOString()`.
  assert.equal(absoluteTime(1757200000000), '2025-09-06 23:06:40 UTC');
  assert.equal(absoluteTime(1), '1970-01-01 00:00:00 UTC');
  assert.equal(absoluteTime(0), 'never');
  assert.equal(absoluteTime(null), 'never');
  assert.equal(absoluteTime(8.64e15 + 1), 'never');
});

test('formatDuration', () => {
  assert.equal(formatDuration(0), '0 ms');
  assert.equal(formatDuration(820), '820 ms');
  assert.equal(formatDuration(4200), '4.2 s');
  assert.equal(formatDuration(187000), '3m 07s');
  assert.equal(formatDuration(-1), DASH);
  assert.equal(formatDuration('4'), DASH);
});

test('groupDigits', () => {
  assert.equal(groupDigits(0), '0');
  assert.equal(groupDigits(999), '999');
  assert.equal(groupDigits(1000), '1,000');
  assert.equal(groupDigits(1234567), '1,234,567');
  assert.equal(groupDigits(-4321), '-4,321');
  assert.equal(groupDigits(NaN), DASH);
});

test('percentOf: clamped, never divides by zero', () => {
  assert.equal(percentOf(0, 100), 0);
  assert.equal(percentOf(50, 200), 25);
  assert.equal(percentOf(300, 200), 100);
  assert.equal(percentOf(-5, 200), 0);
  assert.equal(percentOf(5, 0), 0);
  assert.equal(percentOf(5, -1), 0);
  assert.equal(percentOf(5, undefined), 0);
});

test('sparklinePath: zero baseline, not the series minimum', () => {
  // Two hours, 0 then 10: the line must span the full height.
  assert.equal(sparklinePath([0, 10], 100, 20), 'M0,20 L100,0');
  // A flat non-zero series sits at the top, a flat zero series at the floor.
  assert.equal(sparklinePath([4, 4, 4], 100, 20), 'M0,0 L50,0 L100,0');
  assert.equal(sparklinePath([0, 0], 100, 20), 'M0,20 L100,20');
});

test('sparklinePath: one point draws a flat rule across the box', () => {
  assert.equal(sparklinePath([7], 100, 20), 'M0,0 L100,0');
});

test('sparklinePath: empty and hostile input draws nothing', () => {
  assert.equal(sparklinePath([], 100, 20), '');
  assert.equal(sparklinePath(null, 100, 20), '');
  assert.equal(sparklinePath('0,1', 100, 20), '');
  assert.equal(sparklinePath([1, 2], 0, 20), '');
  assert.equal(sparklinePath([1, 2], 100, 0), '');
  assert.equal(sparklinePath([1, 2], NaN, 20), '');
});

test('sparklinePath: negative and non-numeric samples floor at zero', () => {
  assert.equal(sparklinePath([-4, 8], 100, 20), 'M0,20 L100,0');
  assert.equal(sparklinePath([null, 8], 100, 20), 'M0,20 L100,0');
});

test('versionsPerHour: reads counts out of the shape docs/protocol.md pins', () => {
  assert.deepEqual(versionsPerHour({ versions_per_hour: [{ hour: 1757200000, count: 3 }] }), [3]);
  assert.deepEqual(
    versionsPerHour({ versions_per_hour: [{ count: -2 }, { count: 'x' }, null] }),
    [0, 0, 0],
  );
  assert.deepEqual(versionsPerHour(undefined), []);
  assert.deepEqual(versionsPerHour({}), []);
});

test('versionsPerHour: a bare array is not the pinned shape and reads as empty', () => {
  // The tolerance for a loose shape is gone now that the contract is written
  // down: a server sending something else must fail visibly, not silently.
  assert.deepEqual(versionsPerHour([1, 2, 3]), []);
  assert.deepEqual(versionsPerHour({ versions_per_hour: { 0: 1 } }), []);
  // Nor inside the envelope: an entry is an object with a count, not a bare
  // number, so a server sending the wrong entry shape reads as zero.
  assert.deepEqual(versionsPerHour({ versions_per_hour: [1, 2] }), [0, 0]);
});

test('formatRate: a throughput budget in binary units', () => {
  assert.equal(formatRate(4 * MiB), '4.0 MiB/s');
  assert.equal(formatRate(0), '0 B/s');
  assert.equal(formatRate(1023), '1023 B/s');
  assert.equal(formatRate(-1), DASH);
  assert.equal(formatRate(undefined), DASH);
  assert.equal(formatRate('4MiB/s'), DASH);
});

test('platformGlyphId: one symbol per protocol platform, generic fallback', () => {
  assert.equal(platformGlyphId('ios'), 'g-ios');
  assert.equal(platformGlyphId('ipados'), 'g-ipados');
  assert.equal(platformGlyphId('android'), 'g-android');
  assert.equal(platformGlyphId('macos'), 'g-macos');
  assert.equal(platformGlyphId('windows'), 'g-windows');
  assert.equal(platformGlyphId('linux'), 'g-linux');
  assert.equal(platformGlyphId('  MacOS '), 'g-macos');
  assert.equal(platformGlyphId('haiku'), 'g-device');
  assert.equal(platformGlyphId(undefined), 'g-device');
});

test('platformLabel', () => {
  assert.equal(platformLabel('ios'), 'iOS');
  assert.equal(platformLabel('ipados'), 'iPadOS');
  assert.equal(platformLabel('macos'), 'macOS');
  assert.equal(platformLabel('windows'), 'Windows');
  assert.equal(platformLabel('linux'), 'Linux');
  assert.equal(platformLabel('android'), 'Android');
  assert.equal(platformLabel('haiku'), 'haiku');
  assert.equal(platformLabel('   '), 'Unknown');
  assert.equal(platformLabel(null), 'Unknown');
});

test('csrfToken: parses the double-submit cookie out of a cookie string', () => {
  assert.equal(csrfToken('obsync_csrf=abc123'), 'abc123');
  assert.equal(csrfToken('a=1; obsync_csrf=abc123; b=2'), 'abc123');
  assert.equal(csrfToken('a=1;obsync_csrf=abc123;b=2'), 'abc123');
  assert.equal(csrfToken('  obsync_csrf=abc123  '), 'abc123');
});

test('csrfToken: absent, empty, and near-miss names yield no token', () => {
  assert.equal(csrfToken(''), '');
  assert.equal(csrfToken('obsync_session=zzz'), '');
  assert.equal(csrfToken('x_obsync_csrf=nope'), '');
  assert.equal(csrfToken('obsync_csrf_extra=nope'), '');
  assert.equal(csrfToken('obsync_csrf'), '');
  assert.equal(csrfToken('obsync_csrf='), '');
  assert.equal(csrfToken(null), '');
  assert.equal(csrfToken(undefined), '');
});

test('routeFromHash: known routes, everything else is Overview', () => {
  for (const name of routes()) {
    assert.equal(routeFromHash(`#${name}`), name);
  }
  assert.equal(routes().length, 6);
  assert.equal(routeFromHash('#Devices'), 'devices');
  assert.equal(routeFromHash('#logs?device=ab'), 'logs');
  assert.equal(routeFromHash(''), 'overview');
  assert.equal(routeFromHash('#'), 'overview');
  assert.equal(routeFromHash('#nope'), 'overview');
  assert.equal(routeFromHash('#../../etc/passwd'), 'overview');
  assert.equal(routeFromHash(null), 'overview');
});

const DEVICES = [
  {
    device_id: 'b'.repeat(32),
    name: 'Old iPad',
    platform: 'ipados',
    app_version: '0.1.0',
    created: 1757100000000,
    // Deliberately the most recently seen device: only the revoked-last rule
    // can sink it, so a last-seen-only sort fails this fixture.
    last_seen: 1757199999000,
    revoked: true,
    policy: { per_file_max_bytes: 512 * MiB, total_budget_bytes: 50 * GiB },
    history: [{ ts: 1, event: 'sign_in' }],
  },
  {
    device_id: 'a'.repeat(32),
    name: 'Studio',
    platform: 'macos',
    app_version: '0.1.1',
    created: 1757000000000,
    last_sign_in: 1757100000000,
    last_seen: 1757199500000,
    last_edit: 1757199400000,
    address: '203.0.113.7',
    country: 'ES',
    policy: { per_file_max_bytes: 0, total_budget_bytes: 0 },
  },
  { device_id: 'c'.repeat(32), platform: 'ios', last_seen: 1757199900000 },
];

// What the server sends for a device that has just been paired: explicit
// nulls, not absent fields (docs/protocol.md, `GET /v1/admin/devices`).
const FRESH = {
  device_id: 'e'.repeat(32),
  name: 'Bench',
  platform: 'linux',
  app_version: '0.1.0',
  created: 1757199990000,
  last_sign_in: null,
  last_seen: null,
  last_edit: null,
  address: null,
  country: null,
  policy: { per_file_max_bytes: 0, total_budget_bytes: 0 },
  revoked: false,
};

test('volumeNote: an ordinary volume states the threshold it refuses below', () => {
  const note = volumeNote({ bytes_free: 79 * GiB, watermark_bytes: 12.5 * GiB });
  assert.equal(note, 'Writes are refused below 12.5 GiB free.');
});

test('volumeNote: a volume at its watermark says writes are being refused', () => {
  const note = volumeNote({ bytes_free: 1 * GiB, watermark_bytes: 2 * GiB });
  assert.match(note, /^Below the watermark: writes are refused with 507/);
});

test('volumeNote: an unverified usage figure is never dressed up as a threshold', () => {
  // The stale state wins over both of the others. The server is refusing
  // writes because it cannot trust this number, so a page that printed the
  // ordinary sentence would claim a comparison the server itself will not
  // make -- and it would do so most convincingly when the figure happens to
  // look comfortable.
  const roomy = volumeNote({
    bytes_free: 79 * GiB,
    watermark_bytes: 12.5 * GiB,
    usage_unverified: true,
  });
  assert.match(roomy, /could not be re-measured/);
  assert.match(roomy, /refused until a survey succeeds/);
  assert.doesNotMatch(roomy, /Writes are refused below/);

  const low = volumeNote({ bytes_free: 1 * GiB, watermark_bytes: 2 * GiB, usage_unverified: true });
  assert.equal(low, roomy, 'the reason is the same whichever way the figure reads');
});

test('volumeNote: a missing watermark is not a full disk, and not a crash', () => {
  assert.equal(volumeNote({}), 'Writes are refused below the free-space watermark.');
  assert.equal(volumeNote(null), 'Writes are refused below the free-space watermark.');
});

test('volumeIsLow: absent numbers read as not low, and equality counts as low', () => {
  assert.equal(volumeIsLow({ bytes_free: 3, watermark_bytes: 2 }), false);
  assert.equal(volumeIsLow({ bytes_free: 2, watermark_bytes: 2 }), true);
  assert.equal(volumeIsLow({ bytes_free: 1, watermark_bytes: 2 }), true);
  assert.equal(volumeIsLow({ watermark_bytes: 2 }), false, 'no figure is not a full disk');
  assert.equal(volumeIsLow({ bytes_free: 1 }), false);
  assert.equal(volumeIsLow(undefined), false);
});

test('buildDeviceRows: a freshly paired device renders its nulls, not "undefined"', () => {
  const [row] = buildDeviceRows([FRESH]);
  assert.equal(row.lastSignIn, null);
  assert.equal(row.lastSeen, null);
  assert.equal(row.lastEdit, null);
  assert.equal(row.address, DASH);
  assert.equal(row.country, DASH);
  // and those nulls read as "never" wherever the page prints a time.
  for (const ts of [row.lastSignIn, row.lastSeen, row.lastEdit]) {
    assert.equal(relativeTime(ts, 1757200000000), 'never');
    assert.equal(absoluteTime(ts), 'never');
  }
  assert.equal(row.name, 'Bench');
  assert.equal(row.created, 1757199990000);
  assert.equal(row.perFile, 'Unlimited');
});

test('buildDeviceRows: a device with nothing to sort on still sorts before a revoked one', () => {
  const rows = buildDeviceRows([DEVICES[0], FRESH]);
  assert.deepEqual(
    rows.map((r) => r.name),
    ['Bench', 'Old iPad'],
  );
});

test('buildDeviceRows: shapes rows and puts revoked devices last', () => {
  const rows = buildDeviceRows(DEVICES);
  assert.deepEqual(
    rows.map((r) => r.name),
    ['(unnamed)', 'Studio', 'Old iPad'],
  );
  assert.equal(rows[2].revoked, true);
  assert.equal(rows[0].revoked, false);
});

test('buildDeviceRows: human units, glyphs, and placeholders', () => {
  const [unnamed, studio, ipad] = buildDeviceRows(DEVICES);
  assert.equal(studio.platform, 'macOS');
  assert.equal(studio.glyph, 'g-macos');
  assert.equal(studio.perFile, 'Unlimited');
  assert.equal(studio.budget, 'Unlimited');
  assert.equal(studio.address, '203.0.113.7');
  assert.equal(studio.country, 'ES');
  assert.equal(ipad.perFile, '512.0 MiB');
  assert.equal(ipad.budget, '50.0 GiB');
  assert.equal(ipad.history.length, 1);
  assert.equal(unnamed.appVersion, DASH);
  assert.equal(unnamed.address, DASH);
  assert.equal(unnamed.country, DASH);
  assert.equal(unnamed.perFile, DASH);
  assert.equal(unnamed.lastSignIn, null);
  assert.equal(unnamed.lastEdit, null);
  assert.deepEqual(unnamed.history, []);
});

test('buildDeviceRows: hostile input', () => {
  assert.deepEqual(buildDeviceRows(undefined), []);
  assert.deepEqual(buildDeviceRows({}), []);
  assert.deepEqual(buildDeviceRows([null, 'x']), []);
  const [row] = buildDeviceRows([{}]);
  assert.equal(row.id, '');
  assert.equal(row.platform, 'Unknown');
  assert.equal(row.glyph, 'g-device');
  assert.equal(row.revoked, false);
});

test('buildDeviceRows: ties break by name, not by input order', () => {
  const rows = buildDeviceRows([
    { device_id: '2', name: 'Zeta', last_seen: 5 },
    { device_id: '1', name: 'Alpha', last_seen: 5 },
  ]);
  assert.deepEqual(
    rows.map((r) => r.name),
    ['Alpha', 'Zeta'],
  );
});

const LINES = [
  { ts: 10, device: 'ab12', decision: 'accept' },
  { ts: 30, device: 'AB34', decision: 'refuse' },
  { ts: 20, device: null, decision: 'accept' },
  { ts: 40, device: 'cd56', decision: 'accept' },
];

test('filterLogs: newest first, prefix match, case-insensitive', () => {
  assert.deepEqual(
    filterLogs(LINES, '').map((l) => l.ts),
    [40, 30, 20, 10],
  );
  assert.deepEqual(
    filterLogs(LINES, 'ab').map((l) => l.ts),
    [30, 10],
  );
  assert.deepEqual(
    filterLogs(LINES, '  AB  ').map((l) => l.ts),
    [30, 10],
  );
  assert.deepEqual(filterLogs(LINES, 'zz'), []);
});

test('filterLogs: a prefix drops device-less lines; hostile input is empty', () => {
  assert.deepEqual(
    filterLogs(LINES, 'c').map((l) => l.ts),
    [40],
  );
  assert.deepEqual(filterLogs(LINES, 'a').length, 2);
  assert.deepEqual(filterLogs(null, ''), []);
  assert.deepEqual(filterLogs([null, 3], ''), []);
  assert.deepEqual(
    filterLogs(LINES, null).map((l) => l.ts),
    [40, 30, 20, 10],
  );
});
