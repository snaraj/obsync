// What the page DOES, driven through app.js itself over the stand-in document
// and fetch in dom.mjs.
//
//   node --test dashboard/test/
//
// html.test.mjs reads these files as text and pins their shape: the ids exist,
// nothing builds DOM from a string, the mock answers every route. Reading
// source cannot say whether a control is wired to the right request or a
// payload field reaches the element it is supposed to show, and a test that
// only reads source passes while every one of those is broken. These are the
// behaviours this page would be a security defect without: the recovery
// notice, sign-out-everywhere, and the revoke confirmation.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { makeDocument, makeFetch, reply, settle } from './dom.mjs';

const ADMIN = '/v1/admin';
const CSRF = 'c0ffee';
const COOKIE = `__Host-obsync_csrf=${CSRF}`;

/// The overview payload, with whatever the case under test changes.
const overview = (extra = {}) => ({
  account: {
    name: 'vault',
    account_id: 'acc-1',
    created: 1_757_200_000_000,
    device_count: 2,
    used_bytes: 4096,
    quota_bytes: 0,
  },
  activity: { versions_per_hour: [{ hour: 1, count: 3 }] },
  versions: { total: 9, files: 4 },
  last_gc: null,
  last_scrub: null,
  volumes: [],
  edge: 'none',
  public_url: 'https://sync.example.org',
  session: {},
  ...extra,
});

/// Every module instance is its own page: the query string makes Node load a
/// fresh copy, so one test's wiring and state never reach the next.
let instance = 0;

async function open({ hash = '', routes = {}, cookie = COOKIE } = {}) {
  const document = makeDocument(cookie);
  const net = makeFetch(routes);
  const page = await import(`../app.js?case=${(instance += 1)}`);
  page.start({
    document,
    window: { addEventListener() {} },
    location: { hash },
    clipboard: null,
    fetch: net.fetch,
  });
  await settle();
  const el = (id) => document.getElementById(id);
  assert.equal(el('banner').hidden, true, `the page reported an error: ${el('banner-text').textContent}`);
  return { document, net, el, page };
}

/* ---- the recovery notice ------------------------------------------------ */

test('a session opened with the recovery token is announced on the page', async () => {
  const { el } = await open({
    routes: { [`GET ${ADMIN}/overview`]: reply(200, overview({ session: { recovery: true } })) },
  });
  assert.equal(
    el('recovery-note').hidden,
    false,
    'the standing break-glass credential opened this session and the page must say so',
  );
});

test('an ordinary session shows no recovery notice, and neither does a payload without the field', async () => {
  const link = await open({
    routes: { [`GET ${ADMIN}/overview`]: reply(200, overview({ session: { recovery: false } })) },
  });
  assert.equal(link.el('recovery-note').hidden, true);

  const older = await open({
    routes: { [`GET ${ADMIN}/overview`]: reply(200, overview()) },
  });
  assert.equal(older.el('recovery-note').hidden, true, 'an absent field is not a recovery session');
});

/* ---- sign out everywhere ------------------------------------------------ */

test('Sign out everywhere posts once, with the CSRF header, and signs the page out', async () => {
  const { el, net, document } = await open({
    routes: {
      [`GET ${ADMIN}/overview`]: reply(200, overview()),
      [`POST ${ADMIN}/logout-all`]: reply(204),
    },
  });

  assert.equal(el('signout-all').click(), 1, 'the control is wired to exactly one handler');
  await settle();

  const posts = net.of('POST', `${ADMIN}/logout-all`);
  assert.equal(posts.length, 1, `exactly one request, not ${posts.length}`);
  assert.equal(
    posts[0].headers['X-Obsync-Csrf'],
    CSRF,
    'the double-submit header is what the server checks the cookie against',
  );
  assert.equal(
    net.calls.filter((c) => c.path === `${ADMIN}/logout-all`).length,
    1,
    'and it reached that path by no other method',
  );

  // 204 means every session is gone, including this browser's: the page has
  // to stop showing signed-in chrome or it invites a click that cannot work.
  assert.equal(el('page-signin').hidden, false, 'the sign-in view is shown');
  assert.equal(el('signout').hidden, true);
  assert.equal(el('signout-all').hidden, true);
  assert.equal(document.querySelector('.tabs').hidden, true, 'the tabs go with them');
  for (const name of ['overview', 'devices', 'pairing', 'storage', 'install', 'logs']) {
    assert.equal(el(`page-${name}`).hidden, true, `${name} is still shown`);
  }
});

test('a page with no CSRF cookie does not send the request at all', async () => {
  const { el, net } = await open({
    cookie: '',
    routes: {
      [`GET ${ADMIN}/overview`]: reply(200, overview()),
      [`POST ${ADMIN}/logout-all`]: reply(204),
    },
  });
  el('signout-all').click();
  await settle();
  assert.deepEqual(net.of('POST', `${ADMIN}/logout-all`), [], 'no cookie, no mutation');
  assert.equal(el('banner').hidden, false, 'and the page says why instead of failing silently');
});

/* ---- the revoke confirmation -------------------------------------------- */

const DEVICE = {
  device_id: 'dev-1',
  name: 'laptop',
  platform: 'macos',
  app_version: '1.0.3',
  created: 1_757_200_000_000,
  last_seen: 1_757_200_000_000,
  policy: { per_file_max_bytes: 0, total_budget_bytes: 0 },
  history: [],
};

async function devicesPage() {
  const opened = await open({
    hash: '#devices',
    routes: {
      [`GET ${ADMIN}/devices`]: reply(200, { devices: [DEVICE] }),
      [`POST ${ADMIN}/devices/dev-1/revoke`]: reply(204),
    },
  });
  const row = opened.document.clonesOf('tpl-device')[0];
  assert.ok(row, 'the devices table rendered a row to confirm against');
  return { ...opened, row };
}

test('revoking asks first: Revoke opens the confirmation and sends nothing', async () => {
  const { net, row } = await devicesPage();
  row.field('revoke-open').click();
  await settle();

  assert.equal(row.field('confirm').hidden, false, 'the confirmation is showing');
  assert.equal(row.field('revoke-open').hidden, true, 'and the button that opened it is not');
  assert.deepEqual(
    net.of('POST', `${ADMIN}/devices/dev-1/revoke`),
    [],
    'opening a confirmation must never be the action it confirms',
  );
});

test('Cancel closes the confirmation and sends nothing; Revoke device sends exactly one POST', async () => {
  const { net, row } = await devicesPage();
  row.field('revoke-open').click();
  row.field('revoke-cancel').click();
  await settle();
  assert.equal(row.field('confirm').hidden, true, 'cancelling closes it');
  assert.deepEqual(net.of('POST', `${ADMIN}/devices/dev-1/revoke`), [], 'and revokes nothing');

  row.field('revoke-open').click();
  row.field('revoke-do').click();
  await settle();
  const posts = net.of('POST', `${ADMIN}/devices/dev-1/revoke`);
  assert.equal(posts.length, 1, `confirming revokes once, not ${posts.length} times`);
  assert.equal(posts[0].headers['X-Obsync-Csrf'], CSRF);
});

/* ---- the page starts itself in a browser -------------------------------- */

// Every test above hands `start()` its own stand-ins, which is what makes the
// wiring testable -- and which means none of them touches the one line that
// calls `start()` in a browser. Deleting that line leaves the whole file above
// green and ships a dashboard that loads and then does nothing at all. This
// test is the only one that never calls `start()`: it puts the browser globals
// app.js reads in place, imports the module, and asks whether the page came up.
test('importing the module in a browser starts the page, with nothing calling start()', async () => {
  const document = makeDocument(COOKIE);
  const net = makeFetch({ [`GET ${ADMIN}/overview`]: reply(200, overview()) });
  const before = Object.fromEntries(
    ['document', 'location', 'fetch', 'addEventListener'].map((name) => [name, globalThis[name]]),
  );
  Object.assign(globalThis, {
    document,
    location: { hash: '' },
    fetch: net.fetch,
    addEventListener() {},
  });
  try {
    await import(`../app.js?browser=${(instance += 1)}`);
    await settle();
  } finally {
    for (const [name, value] of Object.entries(before)) {
      if (value === undefined) delete globalThis[name];
      else globalThis[name] = value;
    }
  }

  const el = (id) => document.getElementById(id);
  assert.equal(el('banner').hidden, true, `the page reported an error: ${el('banner-text').textContent}`);
  assert.equal(
    net.of('GET', `${ADMIN}/overview`).length,
    1,
    'the page never asked the server for anything, so the module did not start itself',
  );
  assert.equal(el('acc-name').textContent, 'vault', 'the payload never reached the page');
  assert.equal(document.title, 'obsync — overview', 'no view was ever routed to');
  assert.ok(el('signout').listeners.has('click'), 'sign-out was never wired');
});
