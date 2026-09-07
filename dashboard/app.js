// obsync dashboard — the whole application.
//
// No framework, no build step, no remote asset, no inline script or style:
// the server's CSP is `default-src 'self'; script-src 'self'; style-src
// 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'`
// and this file must never need an exception to it. Nothing here writes an
// inline style or a style attribute either; the usage meters and the
// sparkline are SVG geometry set through plain attributes.
//
// Every value the server sends is formatted by lib.js, which is pure and
// tested under `node --test`. This file is the impure half: fetch, DOM, and
// event wiring only.

import * as L from './lib.js';

const ADMIN = '/v1/admin';

const state = { overview: null, logs: [], signedIn: true, retry: null };

const el = (id) => document.getElementById(id);
const field = (root, name) => root.querySelector(`[data-f="${name}"]`);
const clone = (id) => el(id).content.cloneNode(true);

class ApiError extends Error {
  constructor(status, code, detail) {
    super(detail || code || `HTTP ${status}`);
    this.status = status;
    this.code = code;
  }
}

/* ---- small DOM helpers ------------------------------------------------ */

function setText(node, value) {
  if (!node) return;
  node.textContent = value === undefined || value === null || value === '' ? L.DASH : String(value);
  node.classList.remove('skel');
}

// Relative time in the cell, absolute UTC in the tooltip, on one line.
function setTime(node, ts) {
  if (!node) return;
  node.textContent = L.relativeTime(ts, Date.now());
  node.title = L.absoluteTime(ts);
  node.classList.remove('skel');
}

function say(message) {
  el('status').textContent = message;
}

function showError(message, retry) {
  el('banner-text').textContent = message;
  el('banner').hidden = false;
  el('banner-retry').hidden = typeof retry !== 'function';
  state.retry = typeof retry === 'function' ? retry : null;
}

function clearError() {
  el('banner').hidden = true;
  state.retry = null;
}

// Reserve the vertical space a table is about to fill, so arriving data
// never pushes the page around.
function skeleton(body, columns, rows) {
  body.replaceChildren();
  for (let i = 0; i < rows; i += 1) {
    const tr = document.createElement('tr');
    tr.className = 'skelrow';
    const td = document.createElement('td');
    td.colSpan = columns;
    td.className = 'skel';
    td.textContent = ' ';
    tr.append(td);
    body.append(tr);
  }
}

/* ---- transport -------------------------------------------------------- */

async function request(method, path, body) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (method !== 'GET') {
    // Double submit: the header must equal the readable cookie.
    const token = L.csrfToken(document.cookie);
    if (!token) throw new ApiError(0, 'no_csrf_cookie', 'This browser holds no CSRF cookie. Sign in again.');
    headers['X-Obsync-Csrf'] = token;
  }

  let res;
  try {
    res = await fetch(path, {
      method,
      headers,
      credentials: 'same-origin',
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (cause) {
    throw new ApiError(0, 'unreachable', 'The server did not answer. It may be restarting.');
  }

  const seq = res.headers.get('X-Obsync-Seq');
  if (seq) setText(el('foot-seq'), `seq ${seq}`);

  if (res.status === 401) {
    showSignin();
    throw new ApiError(401, 'unauthenticated', 'This session is signed out.');
  }
  if (!res.ok) {
    let code = `http_${res.status}`;
    let detail = `The server refused with ${res.status}.`;
    try {
      const parsed = await res.json();
      if (parsed && typeof parsed === 'object') {
        code = parsed.error || code;
        detail = parsed.detail || detail;
      }
    } catch (cause) {
      /* a non-JSON error body is still an error; keep the status text */
    }
    throw new ApiError(res.status, code, detail);
  }
  if (res.status === 202 || res.status === 204) return null;
  return res.json();
}

const get = (path) => request('GET', path);

/* ---- shared renderers -------------------------------------------------- */

function renderVolumes(host, volumes) {
  host.replaceChildren();
  if (!Array.isArray(volumes) || volumes.length === 0) {
    const p = document.createElement('p');
    p.className = 'empty';
    p.textContent = 'No volume is reporting yet.';
    host.append(p);
    return;
  }
  for (const v of volumes) {
    const node = clone('tpl-volume');
    const usedPct = L.percentOf(v.bytes_used, v.bytes_total);
    const low = typeof v.bytes_free === 'number' && typeof v.watermark_bytes === 'number'
      && v.bytes_free <= v.watermark_bytes;

    setText(field(node, 'role'), v.role);
    setText(field(node, 'class'), v.path_class);
    setText(field(node, 'used'), L.formatBytes(v.bytes_used));
    setText(field(node, 'total'), L.formatBytes(v.bytes_total));
    setText(field(node, 'free'), L.formatBytes(v.bytes_free));
    setText(
      field(node, 'watermark'),
      low
        ? `Below the watermark: writes are refused with 507 until ${L.formatBytes(v.watermark_bytes)} is free.`
        : `Writes are refused below ${L.formatBytes(v.watermark_bytes)} free.`,
    );
    field(node, 'bartitle').textContent =
      `${v.role}: ${usedPct.toFixed(0)} percent used, ${L.formatBytes(v.bytes_free)} free`;

    // Geometry only: attributes, never a style property (CSP, and no CSSOM).
    const fill = field(node, 'fill');
    fill.setAttribute('width', usedPct.toFixed(2));
    if (low) fill.classList.add('hot');
    // The watermark sits at the used-percentage where free space runs out.
    const markPct = 100 - L.percentOf(v.watermark_bytes, v.bytes_total);
    const mark = field(node, 'mark');
    mark.setAttribute('x1', markPct.toFixed(2));
    mark.setAttribute('x2', markPct.toFixed(2));

    host.append(node);
  }
}

/* ---- overview ---------------------------------------------------------- */

async function loadOverview() {
  const data = await get(`${ADMIN}/overview`);
  state.overview = data;
  const account = data.account && typeof data.account === 'object' ? data.account : {};

  setText(el('acc-name'), account.name);
  setText(el('acc-id'), account.account_id);
  setTime(el('acc-created'), account.created);
  setText(el('acc-devices'), L.groupDigits(account.device_count));
  setText(el('acc-used'), L.formatBytes(account.used_bytes));
  setText(el('acc-quota'), account.quota_bytes ? L.formatBytes(account.quota_bytes) : 'No quota');

  const series = L.versionsPerHour(data.activity);
  el('spark-path').setAttribute('d', L.sparklinePath(series, 240, 48));
  const last24 = series.reduce((sum, v) => sum + v, 0);
  setText(el('act-summary'), `${L.groupDigits(last24)} versions in the last 24 h`);
  setText(el('spark-peak'), series.length ? `peak ${L.groupDigits(Math.max(...series))}/h` : '');
  const versions = data.versions && typeof data.versions === 'object' ? data.versions : {};
  setText(
    el('act-total'),
    `${L.groupDigits(versions.total)} versions kept across ${L.groupDigits(versions.files)} files`,
  );

  renderGc(el('gc-summary'), data.last_gc);
  renderScrub(el('scrub-summary'), data.last_scrub);
  renderVolumes(el('overview-volumes'), data.volumes);
  applyEdge(data);
}

function renderGc(root, run) {
  const has = run && typeof run === 'object';
  setTime(field(root, 'ts'), has ? run.ts : null);
  setText(field(root, 'duration'), has ? L.formatDuration(run.duration_ms) : L.DASH);
  setText(field(root, 'chunks'), has ? L.groupDigits(run.chunks_collected) : L.DASH);
  setText(field(root, 'bytes'), has ? L.formatBytes(run.bytes_freed) : L.DASH);
}

function renderScrub(root, run) {
  const has = run && typeof run === 'object';
  setTime(field(root, 'ts'), has ? run.ts : null);
  setText(field(root, 'duration'), has ? L.formatDuration(run.duration_ms) : L.DASH);
  setText(field(root, 'chunks'), has ? L.groupDigits(run.chunks_verified) : L.DASH);
  setText(field(root, 'quarantined'), has ? L.groupDigits(run.quarantined) : L.DASH);
}

/* ---- devices ------------------------------------------------------------ */

async function loadDevices() {
  const body = el('devices-body');
  skeleton(body, 11, 3);
  const data = await get(`${ADMIN}/devices`);
  const rows = L.buildDeviceRows(data.devices);
  body.replaceChildren();
  el('devices-empty').hidden = rows.length > 0;
  rows.forEach((row, i) => body.append(deviceRow(row, i)));
}

function deviceRow(row, index) {
  const node = clone('tpl-device');
  const tr = node.querySelector('tr');
  if (row.revoked) tr.classList.add('off');

  field(node, 'glyph').setAttribute('href', `#${row.glyph}`);
  setText(field(node, 'name'), row.name);
  setText(field(node, 'platform'), row.platform);
  field(node, 'revoked').hidden = !row.revoked;
  setText(field(node, 'app'), row.appVersion);
  setTime(field(node, 'created'), row.created);
  setTime(field(node, 'signin'), row.lastSignIn);
  setTime(field(node, 'seen'), row.lastSeen);
  setTime(field(node, 'edit'), row.lastEdit);
  setText(field(node, 'address'), row.address);
  setText(field(node, 'country'), row.country);
  setText(field(node, 'perfile'), row.perFile);
  setText(field(node, 'budget'), row.budget);

  const history = clone('tpl-history');
  const historyRow = history.querySelector('tr');
  historyRow.id = `device-history-${index}`;
  const events = field(history, 'events');
  for (const event of row.history) {
    const item = clone('tpl-event');
    const when = field(item, 'ts');
    when.textContent = L.relativeTime(event.ts, Date.now());
    when.title = L.absoluteTime(event.ts);
    setText(field(item, 'event'), event.event);
    setText(field(item, 'where'), [event.address, event.country].filter(Boolean).join(' · '));
    events.append(item);
  }
  field(history, 'empty').hidden = row.history.length > 0;

  const toggle = field(node, 'history-toggle');
  toggle.setAttribute('aria-controls', historyRow.id);
  toggle.addEventListener('click', () => {
    const opening = historyRow.hidden;
    historyRow.hidden = !opening;
    toggle.setAttribute('aria-expanded', String(opening));
  });

  const open = field(node, 'revoke-open');
  const confirm = field(node, 'confirm');
  if (row.revoked) {
    open.hidden = true;
  } else {
    setText(field(node, 'confirm-text'), `Revoke ${row.name}? Its next request fails.`);
    open.addEventListener('click', () => {
      open.hidden = true;
      confirm.hidden = false;
      field(node, 'revoke-do').focus();
    });
    field(node, 'revoke-cancel').addEventListener('click', () => {
      confirm.hidden = true;
      open.hidden = false;
      open.focus();
    });
    field(node, 'revoke-do').addEventListener('click', () => {
      guard(async () => {
        await request('POST', `${ADMIN}/devices/${encodeURIComponent(row.id)}/revoke`);
        say(`${row.name} is revoked. Its next request fails.`);
        await loadDevices();
      });
    });
  }

  const out = document.createDocumentFragment();
  out.append(node, history);
  return out;
}

/* ---- pairing ------------------------------------------------------------ */

async function loadPairing() {
  const data = state.overview || (await get(`${ADMIN}/overview`));
  state.overview = data;
  setText(el('public-url'), data.public_url || 'not configured');
  applyEdge(data);
}

// The dashboard names no provider. Any edge mode other than the default
// means the operator put a managed edge in front, and the service-token
// note applies; the mode itself is printed as the server reported it.
function applyEdge(data) {
  const mode = typeof data.edge === 'string' && data.edge ? data.edge : 'none';
  const managed = mode !== 'none';
  el('edge-note').hidden = !managed;
  if (managed) el('edge-mode').textContent = mode;
}

/* ---- storage ------------------------------------------------------------ */

async function loadStorage() {
  const body = el('quarantine-body');
  skeleton(body, 4, 2);
  const data = await get(`${ADMIN}/storage`);

  renderVolumes(el('storage-volumes'), data.volumes);

  const retention = data.retention && typeof data.retention === 'object' ? data.retention : {};
  setText(el('ret-versions'), L.groupDigits(retention.versions));
  setText(el('ret-days'), L.groupDigits(retention.days));
  setText(el('ret-watermark'), data.watermark && data.watermark.spec);

  const gc = data.gc && typeof data.gc === 'object' ? data.gc : {};
  setText(field(el('gc-state'), 'state'), gc.state);
  renderGc(el('gc-state'), gc.last);

  const scrub = data.scrub && typeof data.scrub === 'object' ? data.scrub : {};
  setText(field(el('scrub-state'), 'state'), scrub.state);
  setText(field(el('scrub-state'), 'rate'), scrub.rate);
  renderScrub(el('scrub-state'), scrub.last);

  const quarantine = Array.isArray(data.quarantine) ? data.quarantine : [];
  body.replaceChildren();
  el('quarantine-empty').hidden = quarantine.length > 0;
  for (const entry of quarantine) {
    const node = clone('tpl-quarantine');
    setText(field(node, 'sid'), entry.sid);
    setTime(field(node, 'ts'), entry.ts);
    setText(field(node, 'bytes'), L.formatBytes(entry.bytes));
    setText(field(node, 'reason'), entry.reason);
    body.append(node);
  }
}

function runJob(button, path, started) {
  guard(async () => {
    button.disabled = true;
    try {
      await request('POST', path);
      say(started);
      await loadStorage();
    } finally {
      button.disabled = false;
    }
  });
}

/* ---- sharing ------------------------------------------------------------ */

async function loadDomains() {
  const body = el('domains-body');
  skeleton(body, 4, 2);
  const data = await get(`${ADMIN}/domains`);
  const domains = Array.isArray(data.domains) ? data.domains : [];
  body.replaceChildren();
  el('domains-empty').hidden = domains.length > 0;
  for (const domain of domains) {
    const node = clone('tpl-domain');
    setText(field(node, 'id'), domain.domain_id);
    setTime(field(node, 'created'), domain.created);
    const escrowed = domain.escrowed === true;
    const tag = field(node, 'escrow');
    setText(tag, escrowed ? 'escrowed — server can read' : 'device keys only');
    if (escrowed) tag.classList.add('on');
    const revoke = field(node, 'revoke');
    revoke.hidden = !escrowed;
    if (escrowed) {
      revoke.addEventListener('click', () => {
        guard(async () => {
          await request('DELETE', `${ADMIN}/domains/${encodeURIComponent(domain.domain_id)}/escrow`);
          say(`Escrow revoked for ${domain.domain_id}. The server can no longer read that folder.`);
          await loadDomains();
        });
      });
    }
    body.append(node);
  }
}

function submitEscrow(event) {
  event.preventDefault();
  const domain = el('escrow-domain').value.trim();
  const key = el('escrow-key').value.trim();
  guard(async () => {
    await request('POST', `${ADMIN}/domains/${encodeURIComponent(domain)}/escrow`, { key });
    el('escrow-form').reset();
    say(`Key escrowed for ${domain}. The server can now read that folder.`);
    await loadDomains();
  });
}

/* ---- install ------------------------------------------------------------ */

async function loadPlugin() {
  const manifest = await get('/v1/plugin/manifest');
  setText(el('sha-bundle'), manifest.bundle_sha256);
  setText(el('sha-styles'), manifest.styles_sha256);
  setText(el('plugin-version'), manifest.version ? `version ${manifest.version}` : L.DASH);
}

/* ---- logs --------------------------------------------------------------- */

async function loadLogs() {
  const data = await get(`${ADMIN}/logs?limit=200`);
  state.logs = Array.isArray(data.lines) ? data.lines : [];
  renderLogs();
}

function renderLogs() {
  const list = el('log-list');
  const lines = L.filterLogs(state.logs, el('log-filter').value);
  list.replaceChildren();
  const empty = el('logs-empty');
  empty.hidden = lines.length > 0;
  empty.textContent = state.logs.length === 0
    ? 'No decision has been logged yet.'
    : 'No decision matches that device id.';
  for (const line of lines) {
    const node = clone('tpl-logline');
    const when = field(node, 'ts');
    when.textContent = L.absoluteTime(line.ts);
    when.title = L.relativeTime(line.ts, Date.now());
    setText(field(node, 'status'), line.status);
    setText(field(node, 'method'), line.method);
    setText(field(node, 'path'), line.path_class);
    setText(field(node, 'device'), line.device || 'no device');
    setText(field(node, 'bytes'), L.formatBytes(line.bytes));
    setText(field(node, 'duration'), L.formatDuration(line.duration_ms));
    setText(field(node, 'decision'), line.decision);
    node.querySelector('li').classList.add(Number(line.status) >= 400 ? 'refuse' : 'accept');
    list.append(node);
  }
}

/* ---- routing ------------------------------------------------------------ */

const LOADERS = {
  overview: loadOverview,
  devices: loadDevices,
  pairing: loadPairing,
  storage: loadStorage,
  sharing: loadDomains,
  install: loadPlugin,
  logs: loadLogs,
};

function guard(work) {
  Promise.resolve()
    .then(work)
    .then(clearError)
    .catch((error) => {
      if (error instanceof ApiError && error.status === 401) return;
      const detail = error instanceof ApiError ? error.message : 'Something went wrong.';
      showError(detail, () => guard(work));
    });
}

function showSignin() {
  state.signedIn = false;
  for (const name of L.routes()) el(`page-${name}`).hidden = true;
  el('page-signin').hidden = false;
  el('signout').hidden = true;
  document.querySelector('.tabs').hidden = true;
  clearError();
  say('');
}

function route() {
  const name = L.routeFromHash(location.hash);
  if (!state.signedIn) {
    showSignin();
    return;
  }
  for (const other of L.routes()) el(`page-${other}`).hidden = other !== name;
  el('page-signin').hidden = true;
  for (const link of document.querySelectorAll('.tabs a')) {
    if (link.dataset.route === name) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
  document.title = `obsync — ${name}`;
  say('');
  clearError();
  guard(LOADERS[name]);
}

/* ---- wiring -------------------------------------------------------------- */

el('banner-retry').addEventListener('click', () => {
  const retry = state.retry;
  clearError();
  if (retry) retry();
});

el('signout').addEventListener('click', () => {
  guard(async () => {
    await request('POST', `${ADMIN}/logout`);
    showSignin();
  });
});

el('copy-url').addEventListener('click', () => {
  const url = el('public-url').textContent;
  if (!navigator.clipboard) {
    say(`This browser will not copy for us. The address is ${url}`);
    return;
  }
  navigator.clipboard.writeText(url).then(
    () => say('Public address copied.'),
    () => say(`Copy it by hand: ${url}`),
  );
});

el('run-gc').addEventListener('click', () =>
  runJob(el('run-gc'), `${ADMIN}/gc/run`, 'Garbage collection started. It logs a summary when it finishes.'));
el('run-scrub').addEventListener('click', () =>
  runJob(el('run-scrub'), `${ADMIN}/scrub/run`, 'Scrub started. It runs at the configured rate and logs a summary.'));

el('escrow-form').addEventListener('submit', submitEscrow);
el('log-filter').addEventListener('input', renderLogs);
window.addEventListener('hashchange', route);

route();
