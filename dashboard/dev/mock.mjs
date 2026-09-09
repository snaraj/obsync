// Development server for the dashboard. Node built-ins only, no arguments
// needed:
//
//   node dashboard/dev/mock.mjs        # http://127.0.0.1:8090
//
// It serves the four real files from dashboard/ and answers every endpoint
// the dashboard calls with fixture data, so the page can be driven end to
// end without obsyncd. Two things make it worth running rather than opening
// index.html from disk:
//
//   * it sends the same CSP the real server sends, so any inline script or
//     style violation shows up in the console here rather than in production;
//   * it enforces the session cookie and the double-submit CSRF header, so a
//     mutation that forgets the header fails here the way it would there.
//
// Fixtures are sentinels only. Addresses are RFC 5737 documentation ranges,
// country codes are the user-assigned "ZZ" and Antarctica, ids are visibly
// patterned, and nothing here comes from any real deployment.

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const DASHBOARD = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const HOST = '127.0.0.1';
const PORT = Number(process.env.PORT || 8090);

// Defaults to the server's own default so no provider name appears anywhere
// under dashboard/. Set OBSYNC_EDGE to a managed-edge value to exercise the
// pairing page's service-token note.
const EDGE = process.env.OBSYNC_EDGE || 'none';

// The header set the real server sends, per AGENTS.md, "Security invariants
// beyond the numbered requirements". Kept here by hand; obsyncd's dashboard
// handler is the authority, and this must be updated with it. The CSP rides
// HTML responses only; the rest ride every response.
const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; " +
  "connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

const FILES = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.css': ['app.css', 'text/css; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/lib.js': ['lib.js', 'text/javascript; charset=utf-8'],
};

const SESSION = 'obsync_session';
const CSRF = 'obsync_csrf';
const SESSION_VALUE = 'dev-session';
const CSRF_VALUE = 'dev-csrf-token';

const HOUR = 3600000;
const MINUTE = 60000;
const MiB = 1024 * 1024;
const GiB = 1024 * MiB;

/* ---- mutable fixture state --------------------------------------------- */

const now = () => Date.now();
let seq = 41207;

const devices = [
  {
    device_id: '4f2a00000000000000000000000000a1',
    name: 'Desk',
    platform: 'macos',
    app_version: '0.1.0',
    created: now() - 62 * 24 * HOUR,
    last_sign_in: now() - 62 * 24 * HOUR,
    last_seen: now() - 40000,
    last_edit: now() - 4 * MINUTE,
    address: '198.51.100.24',
    country: 'ZZ',
    policy: { per_file_max_bytes: 0, total_budget_bytes: 0 },
    revoked: false,
    history: [
      { ts: now() - 4 * MINUTE, event: 'edit', address: '198.51.100.24', country: 'ZZ' },
      { ts: now() - HOUR, event: 'heartbeat', address: '198.51.100.24', country: 'ZZ' },
      { ts: now() - 62 * 24 * HOUR, event: 'sign_in', address: '198.51.100.24', country: 'ZZ' },
    ],
  },
  {
    device_id: '4f2a00000000000000000000000000b2',
    name: 'Pocket',
    platform: 'ios',
    app_version: '0.1.0',
    created: now() - 21 * 24 * HOUR,
    last_sign_in: now() - 21 * 24 * HOUR,
    last_seen: now() - 11 * MINUTE,
    last_edit: now() - 3 * HOUR,
    address: '203.0.113.9',
    country: 'AQ',
    // The mobile defaults from docs/architecture.md 6.2.5.
    policy: { per_file_max_bytes: 512 * MiB, total_budget_bytes: 50 * GiB },
    revoked: false,
    history: [
      { ts: now() - 3 * HOUR, event: 'edit', address: '203.0.113.9', country: 'AQ' },
      { ts: now() - 11 * MINUTE, event: 'heartbeat', address: '203.0.113.9', country: 'AQ' },
    ],
  },
  {
    device_id: '4f2a00000000000000000000000000c3',
    name: 'Office tower',
    platform: 'windows',
    app_version: '0.1.0',
    created: now() - 9 * 24 * HOUR,
    last_sign_in: now() - 2 * 24 * HOUR,
    last_seen: now() - 26 * HOUR,
    last_edit: now() - 2 * 24 * HOUR,
    address: '198.51.100.77',
    country: 'ZZ',
    policy: { per_file_max_bytes: 0, total_budget_bytes: 0 },
    revoked: false,
    history: [{ ts: now() - 2 * 24 * HOUR, event: 'sign_in', address: '198.51.100.77', country: 'ZZ' }],
  },
  {
    // Just paired, nothing has happened on it yet: the server sends null for
    // every event stamp and for the address it has not seen a request from.
    device_id: '4f2a00000000000000000000000000e5',
    name: 'Bench',
    platform: 'linux',
    app_version: '0.1.0',
    created: now() - 3 * MINUTE,
    last_sign_in: null,
    last_seen: null,
    last_edit: null,
    address: null,
    country: null,
    policy: { per_file_max_bytes: 0, total_budget_bytes: 0 },
    revoked: false,
    history: [],
  },
  {
    device_id: '4f2a00000000000000000000000000d4',
    name: 'Old slab',
    platform: 'ipados',
    app_version: '0.0.9',
    created: now() - 140 * 24 * HOUR,
    last_sign_in: now() - 95 * 24 * HOUR,
    last_seen: now() - 95 * 24 * HOUR,
    last_edit: null,
    address: '203.0.113.44',
    country: 'AQ',
    policy: { per_file_max_bytes: 512 * MiB, total_budget_bytes: 50 * GiB },
    revoked: true,
    history: [],
  },
];

const quarantine = [
  {
    sid: '9c1d'.padEnd(64, '0'),
    ts: now() - 31 * HOUR,
    bytes: 4 * MiB,
    reason: 'sid_mismatch on scrub',
  },
];

const volumes = [
  {
    role: 'blobs',
    path_class: 'local-pie-ssd',
    bytes_total: 250 * GiB,
    bytes_used: 171 * GiB,
    bytes_free: 79 * GiB,
    watermark_bytes: 12.5 * GiB,
    usage_unverified: false,
  },
  {
    role: 'journal',
    path_class: 'local-pie-ssd',
    bytes_total: 4 * GiB,
    bytes_used: 3.82 * GiB,
    bytes_free: 0.18 * GiB,
    watermark_bytes: 2 * GiB,
    usage_unverified: false,
  },
  {
    role: 'mirror',
    path_class: 'host',
    bytes_total: 500 * GiB,
    bytes_used: 171 * GiB,
    bytes_free: 329 * GiB,
    watermark_bytes: 25 * GiB,
    usage_unverified: false,
  },
];

const jobs = {
  gc: {
    runningUntil: 0,
    last: { ts: now() - 47 * MINUTE, duration_ms: 1840, chunks_collected: 312, bytes_collected: 2.4 * GiB, chunks_retained: 40896 },
  },
  scrub: {
    runningUntil: 0,
    last: {
      ts: now() - 5 * HOUR,
      duration_ms: 187000,
      chunks_verified: 41208,
      bytes_verified: 96 * GiB,
      mismatches: 1,
      quarantined: 1,
      complete_pass: true,
    },
  },
};

const DECISIONS = [
  ['PUT', '/v1/chunks/{sid}', 201, 8 * MiB, 412, 'accept'],
  ['POST', '/v1/files/{id}/versions', 201, 2048, 6, 'accept'],
  ['GET', '/v1/changes', 200, 512, 54021, 'accept long_poll'],
  ['PUT', '/v1/chunks/{sid}', 507, 0, 2, 'refuse volume_full'],
  ['POST', '/v1/chunks/exists', 200, 1024, 3, 'accept'],
  ['GET', '/v1/chunks/{sid}', 404, 0, 1, 'refuse unknown_chunk'],
  ['POST', '/v1/devices/heartbeat', 204, 0, 2, 'accept'],
  ['GET', '/v1/account', 401, 0, 1, 'refuse device_revoked'],
];

const logs = Array.from({ length: 64 }, (_, i) => {
  const [method, pathClass, status, bytes, duration, decision] = DECISIONS[i % DECISIONS.length];
  const device = i % 9 === 8 ? null : devices[i % devices.length].device_id;
  return {
    ts: now() - i * 7 * MINUTE,
    method,
    path_class: pathClass,
    device,
    status,
    bytes,
    duration_ms: duration,
    decision,
  };
});

function activity() {
  // A plausible day: quiet overnight, busy in two working stretches.
  const shape = [0, 0, 0, 0, 1, 0, 2, 9, 24, 31, 18, 12, 7, 4, 16, 28, 22, 11, 6, 3, 1, 0, 0, 2];
  return {
    versions_per_hour: shape.map((count, i) => ({
      hour: Math.floor((now() - (23 - i) * HOUR) / 1000),
      count,
    })),
  };
}

function jobState(job) {
  return job.runningUntil > now() ? 'running' : 'idle';
}

/* ---- request plumbing --------------------------------------------------- */

function cookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0) out[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
  }
  return out;
}

function head(extra = {}) {
  return {
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Cache-Control': 'no-store',
    'X-Obsync-Seq': String(seq),
    ...extra,
  };
}

function json(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, head({ 'Content-Type': 'application/json; charset=utf-8' }));
  res.end(text);
}

function empty(res, status) {
  res.writeHead(status, head());
  res.end();
}

function fail(res, status, error, detail) {
  json(res, status, { error, detail });
}

async function body(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch (cause) {
    return {};
  }
}

/* ---- routes -------------------------------------------------------------- */

async function serveFile(res, name, type) {
  const text = await readFile(path.join(DASHBOARD, name), 'utf8');
  const extra = { 'Content-Type': type };
  if (type.startsWith('text/html')) extra['Content-Security-Policy'] = CSP;
  res.writeHead(200, head(extra));
  res.end(text);
}

function signIn(res) {
  res.writeHead(302, head({
    Location: '/',
    'Set-Cookie': [
      `${SESSION}=${SESSION_VALUE}; Path=/; HttpOnly; SameSite=Strict`,
      `${CSRF}=${CSRF_VALUE}; Path=/; SameSite=Strict`,
    ],
  }));
  res.end();
}

function signOut(res) {
  res.writeHead(204, head({
    'Set-Cookie': [
      `${SESSION}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`,
      `${CSRF}=; Path=/; SameSite=Strict; Max-Age=0`,
    ],
  }));
  res.end();
}

const ADMIN = {
  'GET /overview': () => ({
    account: {
      account_id: 'acc00000000000000000000000000001',
      name: 'Sentinel vault',
      created: now() - 63 * 24 * HOUR,
      quota_bytes: 200 * GiB,
      used_bytes: 171 * GiB,
      device_count: devices.filter((d) => !d.revoked).length,
    },
    edge: EDGE,
    public_url: 'https://obsync.example',
    volumes,
    versions: { total: 41208, files: 9134 },
    activity: activity(),
    last_gc: jobs.gc.last,
    last_scrub: jobs.scrub.last,
  }),
  'GET /devices': () => ({ devices }),
  'GET /storage': () => ({
    volumes,
    retention: { days: 30, versions: 10 },
    watermark: { spec: '5%,2GiB' },
    gc: { state: jobState(jobs.gc), last: jobs.gc.last },
    scrub: { state: jobState(jobs.scrub), rate_bytes_per_sec: 4 * MiB, last: jobs.scrub.last },
    quarantine,
  }),
  'GET /logs': (url) => adminLogs(url),
};

function adminLogs(url) {
  const prefix = (url.searchParams.get('device') || '').toLowerCase();
  const limit = Number(url.searchParams.get('limit') || 200);
  const lines = logs.filter((l) => !prefix || (l.device || '').toLowerCase().startsWith(prefix));
  return { lines: lines.slice(0, limit) };
}

function mutate(res, method, rest, sent) {
  const revoke = rest.match(/^\/devices\/([^/]+)\/revoke$/);
  if (method === 'POST' && revoke) {
    const device = devices.find((d) => d.device_id === revoke[1]);
    if (!device) return fail(res, 404, 'unknown_device', 'No such device.');
    device.revoked = true;
    seq += 1;
    return empty(res, 204);
  }

  if (method === 'POST' && (rest === '/gc/run' || rest === '/scrub/run')) {
    const job = rest === '/gc/run' ? jobs.gc : jobs.scrub;
    job.runningUntil = now() + 6000;
    job.last = { ...job.last, ts: now() };
    return empty(res, 202);
  }

  return fail(res, 404, 'unknown_endpoint', `No mock for ${method} /v1/admin${rest}.`);
}

const PLUGIN = {
  '/v1/plugin/manifest': [
    'application/json; charset=utf-8',
    JSON.stringify({
      id: 'obsync',
      name: 'obsync',
      version: '0.1.0',
      minAppVersion: '1.5.0',
      isDesktopOnly: false,
      bundle_sha256: 'b'.repeat(64),
      styles_sha256: 'c'.repeat(64),
    }),
  ],
  '/v1/plugin/bundle': ['text/javascript; charset=utf-8', '// mock plugin bundle\n'],
  '/v1/plugin/styles': ['text/css; charset=utf-8', '/* mock plugin styles */\n'],
};

/* ---- the server ---------------------------------------------------------- */

const server = createServer(async (req, res) => {
  // The origin emits no `Date`: a clock dependency with no consumer. This is
  // set per response because Node honours `res.sendDate`, not the server-wide
  // property of the same name (verified on Node v26.8.1).
  res.sendDate = false;

  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  const route = url.pathname;
  const method = req.method || 'GET';

  try {
    if (method === 'GET' && FILES[route]) {
      return await serveFile(res, FILES[route][0], FILES[route][1]);
    }
    if (method === 'GET' && route === '/login') {
      return signIn(res);
    }
    if (method === 'GET' && PLUGIN[route]) {
      const [type, text] = PLUGIN[route];
      res.writeHead(200, head({ 'Content-Type': type }));
      return res.end(text);
    }

    if (route.startsWith('/v1/admin')) {
      const jar = cookies(req);
      if (jar[SESSION] !== SESSION_VALUE) {
        return fail(res, 401, 'unauthenticated', 'No dashboard session. Open /login?token=dev.');
      }
      const rest = route.slice('/v1/admin'.length);

      if (method !== 'GET') {
        // Double submit, exactly as docs/protocol.md requires.
        const header = req.headers['x-obsync-csrf'];
        if (!header || header !== jar[CSRF]) {
          return fail(res, 403, 'csrf_mismatch', 'X-Obsync-Csrf must equal the obsync_csrf cookie.');
        }
        const sent = await body(req);
        if (rest === '/logout') return signOut(res);
        return mutate(res, method, rest, sent);
      }

      const handler = ADMIN[`GET ${rest}`];
      if (handler) return json(res, 200, handler(url));
      return fail(res, 404, 'unknown_endpoint', `No mock for GET /v1/admin${rest}.`);
    }

    return fail(res, 404, 'not_found', `No route for ${method} ${route}.`);
  } catch (error) {
    return fail(res, 500, 'mock_failure', String(error && error.message));
  }
});

server.listen(PORT, HOST, () => {
  process.stdout.write(
    `obsync dashboard mock on http://${HOST}:${PORT}\n` +
      `  sign in:  http://${HOST}:${PORT}/login?token=dev\n` +
      `  signed out until you do; the page shows the sign-in explanation.\n` +
      `  edge mode: ${EDGE} (OBSYNC_EDGE overrides; any value but "none" shows the pairing token note)\n`,
  );
});
