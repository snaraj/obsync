// Structural tests for the served files.
//
//   node --test dashboard/test/
//
// There is no browser here, so index.html is checked as text. Every check is
// a small function over a document string; the last test in this file runs
// each of them against a hostile document and requires it to complain, so no
// check can pass because it never looks at anything.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const DIR = new URL('../', import.meta.url);
const read = (name) => readFileSync(new URL(name, DIR), 'utf8');

const HTML = read('index.html');
const APP_JS = read('app.js');
const LIB_JS = read('lib.js');
const CSS = read('app.css');
const MOCK = read('dev/mock.mjs');

// One tag at a time, tolerating ">" inside a quoted attribute value.
const TAG = /<([a-zA-Z][a-zA-Z0-9-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g;

function tags(html) {
  const out = [];
  for (const match of html.matchAll(TAG)) {
    out.push({ name: match[1].toLowerCase(), attrs: match[2], raw: match[0] });
  }
  return out;
}

function attr(attrs, name) {
  const m = attrs.match(new RegExp(`\\s${name}\\s*=\\s*"([^"]*)"`, 'i'));
  return m ? m[1] : null;
}

/* ---- the checks --------------------------------------------------------- */

// The CSP is `script-src 'self'`: every script must be a fetched file.
function inlineScripts(html) {
  return tags(html)
    .filter((t) => t.name === 'script' && attr(t.attrs, 'src') === null)
    .map((t) => `inline script: ${t.raw}`);
}

// `style-src 'self'` blocks style attributes parsed from markup.
function styleAttributes(html) {
  return tags(html)
    .filter((t) => /\sstyle\s*=/i.test(t.attrs))
    .map((t) => `style attribute: ${t.raw}`);
}

// An on* attribute is an inline script by another name.
function eventAttributes(html) {
  return tags(html)
    .filter((t) => /\son[a-z]+\s*=/i.test(t.attrs))
    .map((t) => `event handler attribute: ${t.raw}`);
}

function imagesWithoutAlt(html) {
  return tags(html)
    .filter((t) => t.name === 'img' && attr(t.attrs, 'alt') === null)
    .map((t) => `image without alt: ${t.raw}`);
}

// Every control needs an id and a <label for> pointing at it.
function controlsWithoutLabel(html) {
  const all = tags(html);
  const labelled = new Set(
    all.filter((t) => t.name === 'label').map((t) => attr(t.attrs, 'for')).filter(Boolean),
  );
  const problems = [];
  for (const t of all) {
    if (!['input', 'select', 'textarea'].includes(t.name)) continue;
    const id = attr(t.attrs, 'id');
    if (!id) problems.push(`control without id: ${t.raw}`);
    else if (!labelled.has(id)) problems.push(`control without label: ${t.raw}`);
  }
  return problems;
}

// index.html may reference exactly the two files the server serves beside it.
function assetReferences(html) {
  const refs = [];
  for (const t of tags(html)) {
    if (t.name === 'link') refs.push(attr(t.attrs, 'href'));
    if (t.name === 'script') refs.push(attr(t.attrs, 'src'));
  }
  return refs.filter(Boolean);
}

// Nothing may reach off-origin, and nothing may build DOM from a string.
const FORBIDDEN_JS = [
  'innerHTML',
  'outerHTML',
  'insertAdjacentHTML',
  'document.write',
  'eval(',
  'new Function',
  'cssText',
  ".setAttribute('style'",
  '.setAttribute("style"',
  '.style.',
  'http://',
  'https://',
];

function forbiddenPatterns(source, needles) {
  return needles.filter((needle) => source.includes(needle)).map((needle) => `forbidden: ${needle}`);
}

// A guard that reads field names out of the source must not be satisfied by
// the comment that explains them. Stripping `//` to end of line is safe here
// only because the test above proves no `://` survives in these files.
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, '');
}

const missingNames = (source, names) => names.filter((name) => !source.includes(name));
const presentNames = (source, names) => names.filter((name) => source.includes(name));

function providerHits(sources, needles) {
  const hits = [];
  for (const [name, source] of Object.entries(sources)) {
    for (const needle of needles) {
      if (source.toLowerCase().includes(needle)) hits.push(`${name}: ${needle}`);
    }
  }
  return hits;
}

/* ---- index.html --------------------------------------------------------- */

test('index.html: no inline script', () => {
  assert.deepEqual(inlineScripts(HTML), []);
});

test('index.html: no style attribute', () => {
  assert.deepEqual(styleAttributes(HTML), []);
});

test('index.html: no on* event handler attribute', () => {
  assert.deepEqual(eventAttributes(HTML), []);
});

test('index.html: every image carries alt text', () => {
  assert.deepEqual(imagesWithoutAlt(HTML), []);
});

test('index.html: every form control has a label', () => {
  assert.deepEqual(controlsWithoutLabel(HTML), []);
  // The page really does have controls, so the check above had work to do.
  const controls = tags(HTML).filter((t) => ['input', 'select', 'textarea'].includes(t.name));
  assert.equal(controls.length, 1);
});

test('index.html: exactly the two asset paths the server serves', () => {
  assert.deepEqual(assetReferences(HTML), ['/app.css', '/app.js']);
  assert.ok(HTML.includes('<link rel="stylesheet" href="/app.css">'));
  assert.ok(HTML.includes('<script type="module" src="/app.js"></script>'));
});

test('index.html: no off-origin reference beyond the SVG namespace', () => {
  const urls = HTML.match(/https?:\/\/[^"'\s>]+/g) || [];
  assert.deepEqual(urls, ['http://www.w3.org/2000/svg']);
});

test('index.html: one section per route, plus sign-in', () => {
  for (const name of ['overview', 'devices', 'pairing', 'storage', 'install', 'logs']) {
    assert.ok(HTML.includes(`id="page-${name}"`), `missing section for ${name}`);
    assert.ok(HTML.includes(`href="#${name}"`), `missing nav link for ${name}`);
  }
  assert.ok(HTML.includes('id="page-signin"'));
});

test('index.html: a symbol exists for every platform glyph app.js can ask for', () => {
  for (const id of ['g-ios', 'g-ipados', 'g-android', 'g-macos', 'g-windows', 'g-linux', 'g-device']) {
    assert.ok(HTML.includes(`<symbol id="${id}"`), `missing symbol ${id}`);
  }
});

/* ---- app.js and lib.js --------------------------------------------------- */

test('app.js: imports lib.js and nothing else', () => {
  const imports = APP_JS.match(/^import .*$/gm) || [];
  assert.deepEqual(imports, ["import * as L from './lib.js';"]);
});

test('lib.js: imports nothing at all', () => {
  assert.deepEqual(LIB_JS.match(/^import .*$/gm), null);
});

test('app.js and lib.js: no string-to-DOM, no CSSOM style write, no remote URL', () => {
  assert.deepEqual(forbiddenPatterns(APP_JS, FORBIDDEN_JS), []);
  assert.deepEqual(forbiddenPatterns(LIB_JS, FORBIDDEN_JS), []);
});

test('app.css: no import and no remote asset', () => {
  assert.deepEqual(forbiddenPatterns(CSS, ['@import', 'url(', 'http://', 'https://']), []);
});

// There is no browser here, so nothing else would notice a typo in an id or
// a data-f name until the page ran. These three tests are that notice.
test('app.js: every element id it reaches for exists in index.html', () => {
  const ids = [...APP_JS.matchAll(/\bel\('([^']+)'\)/g)].map((m) => m[1]);
  assert.ok(ids.length > 15, `expected many id lookups, found ${ids.length}`);
  const missing = [...new Set(ids)]
    .filter((id) => !id.startsWith('page-'))
    .filter((id) => !HTML.includes(`id="${id}"`));
  assert.deepEqual(missing, []);
});

test('app.js: every data-f name it queries exists in a template', () => {
  const names = [...APP_JS.matchAll(/\bfield\([^,]+, '([^']+)'\)/g)].map((m) => m[1]);
  assert.ok(names.length > 25, `expected many field lookups, found ${names.length}`);
  const missing = [...new Set(names)].filter((name) => !HTML.includes(`data-f="${name}"`));
  assert.deepEqual(missing, []);
});

test('app.js: every template it clones exists in index.html', () => {
  const templates = [...APP_JS.matchAll(/\bclone\('([^']+)'\)/g)].map((m) => m[1]);
  assert.ok(templates.length > 4, `expected several templates, found ${templates.length}`);
  const missing = [...new Set(templates)].filter((id) => !HTML.includes(`<template id="${id}">`));
  assert.deepEqual(missing, []);
});

test('the devices table, its skeleton, and its history row agree on 11 columns', () => {
  const head = HTML.slice(HTML.indexOf('id="devices-table"'), HTML.indexOf('id="devices-body"'));
  assert.equal((head.match(/<th scope="col">/g) || []).length, 11);
  assert.ok(HTML.includes('<td colspan="11">'));
  assert.ok(APP_JS.includes('skeleton(body, 11, 3)'));
});

// Every endpoint app.js calls, as the exact literal the mock must contain to
// route it: a table key for a GET, the path itself for a fixed mutation, and
// the anchored tail of the matching regex for a mutation with an id in it.
function mockRouteMarkers(appJs) {
  const markers = [];
  // Bounded to one line, or a function declaration would swallow the next
  // template literal in the file and report a route nobody calls.
  for (const m of appJs.matchAll(/\b(get|request|runJob)\([^`\n]*`\$\{ADMIN\}([^`]+)`/g)) {
    const path = m[2].split('?')[0];
    if (m[1] === 'get') markers.push(`'GET ${path}'`);
    else if (path.includes('${')) markers.push(`${path.slice(path.lastIndexOf('/'))}$`);
    else markers.push(`'${path}'`);
  }
  for (const m of appJs.matchAll(/get\('(\/v1\/[a-z/]+)'\)/g)) markers.push(`'${m[1]}'`);
  return [...new Set(markers)];
}

const missingMockRoutes = (appJs, mockJs) =>
  mockRouteMarkers(appJs).filter((marker) => !mockJs.includes(marker));

// The mock is only useful while it answers what the page actually asks for.
test('dev/mock.mjs answers every endpoint app.js calls', () => {
  const markers = mockRouteMarkers(APP_JS);
  assert.ok(markers.length >= 9, `expected the whole admin surface, found ${markers.join(', ')}`);
  assert.deepEqual(missingMockRoutes(APP_JS, MOCK), []);
});

// The <gc> and <scrub> summaries and the storage scrub object, field for
// field, as docs/protocol.md pins them under "Dashboard (admin) API". The
// second half is the half that matters: these are the names this lane read
// before the contract was written down, and nothing else would notice them
// coming back.
test('app.js reads the pinned admin field names and none of the old ones', () => {
  const pinned = [
    'chunks_collected',
    'bytes_collected',
    'chunks_retained',
    'chunks_verified',
    'bytes_verified',
    'mismatches',
    'quarantined',
    'complete_pass',
    'rate_bytes_per_sec',
    'versions_per_hour',
  ];
  // Comments stripped: the sentence explaining a field must not stand in for
  // the code reading it.
  const source = stripComments(`${APP_JS}${LIB_JS}`);
  assert.deepEqual(missingNames(source, pinned), []);

  // `domain_key` was the one request body that handed the server a content
  // key. It is gone from the protocol; the dashboard must never grow it back.
  const superseded = ['bytes_freed', 'scrub.rate)', 'run.rate)', '{ key }', 'domain_key'];
  assert.deepEqual(presentNames(source, superseded), []);
});

// AGENTS.md, "Deployment-provider contract": the server knows no provider by
// name, and the dashboard holds itself to the same line. Needles are built by
// concatenation so this scan does not match its own source.
test('no file under dashboard/ names an ingress, edge, or access provider', () => {
  const needles = ['cloud' + 'flare', 'tail' + 'scale', 'ng' + 'rok', 'fast' + 'ly', 'akam' + 'ai'];
  const sources = {
    'index.html': HTML,
    'app.js': APP_JS,
    'lib.js': LIB_JS,
    'app.css': CSS,
    'dev/mock.mjs': MOCK,
    'test/html.test.mjs': read('test/html.test.mjs'),
    'test/lib.test.mjs': read('test/lib.test.mjs'),
  };
  assert.deepEqual(providerHits(sources, needles), []);
  // The page still shows the note; it keys on the mode not being the default.
  assert.ok(APP_JS.includes("mode !== 'none'"));
  assert.ok(MOCK.includes("process.env.OBSYNC_EDGE || 'none'"));
});

test('dev/mock.mjs sends the header set AGENTS.md pins', () => {
  // Comment-stripped, so the sentence explaining a header cannot stand in
  // for the code sending it, and so a comment naming a header the origin
  // must NOT send does not read as the origin sending it.
  const code = stripComments(MOCK);
  assert.deepEqual(
    missingNames(code, [
      "default-src 'self'; script-src 'self'; style-src 'self'",
      "connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
      "'X-Content-Type-Options': 'nosniff'",
      "'X-Frame-Options': 'DENY'",
      "'Referrer-Policy': 'no-referrer'",
      "'Cache-Control': 'no-store'",
      "'X-Obsync-Seq'",
      // The CSP rides HTML responses only; the rest ride everything.
      "type.startsWith('text/html')",
      // Per response: Node ignores the server-wide property of this name.
      'res.sendDate = false',
      // Refuses a mutation whose double-submit header does not match.
      "req.headers['x-obsync-csrf']",
      'csrf_mismatch',
    ]),
    [],
  );
  // The origin owns neither the clock nor the transport policy, and no
  // request body it accepts names a key.
  assert.deepEqual(presentNames(code, ['Strict-Transport-Security', '_key']), []);
});

/* ---- the checks themselves ---------------------------------------------- */

test('the checks reject a hostile document', () => {
  assert.equal(inlineScripts('<script>alert(1)</script>').length, 1);
  assert.equal(inlineScripts('<script type="module" src="/app.js"></script>').length, 0);

  assert.equal(styleAttributes('<div style="color:red">x</div>').length, 1);
  assert.equal(styleAttributes('<div class="x">no style here</div>').length, 0);

  assert.equal(eventAttributes('<button onclick="go()">x</button>').length, 1);
  assert.equal(eventAttributes('<button ONCLICK="go()">x</button>').length, 1);
  assert.equal(eventAttributes('<td data-label="Only">x</td>').length, 0);

  assert.equal(imagesWithoutAlt('<img src="/a.png">').length, 1);
  assert.equal(imagesWithoutAlt('<img src="/a.png" alt="a">').length, 0);

  assert.equal(controlsWithoutLabel('<input id="a"><label for="a">A</label>').length, 0);
  assert.equal(controlsWithoutLabel('<input id="a">').length, 1);
  assert.equal(controlsWithoutLabel('<input>').length, 1);
  assert.equal(controlsWithoutLabel('<select id="s"></select>').length, 1);

  assert.deepEqual(assetReferences('<link href="https://cdn.example/x.css">'), [
    'https://cdn.example/x.css',
  ]);

  assert.equal(forbiddenPatterns('node.innerHTML = x;', FORBIDDEN_JS).length, 1);
  assert.equal(forbiddenPatterns("el.style.width = '1px';", FORBIDDEN_JS).length, 1);
  assert.equal(forbiddenPatterns('fetch("https://evil.example")', FORBIDDEN_JS).length, 1);
  assert.equal(forbiddenPatterns('node.textContent = x;', FORBIDDEN_JS).length, 0);

  assert.equal(stripComments('a // b\nc'), 'a \nc');
  assert.equal(stripComments('a /* b\nc */ d'), 'a   d');
  assert.deepEqual(missingNames('has a', ['a', 'b']), ['b']);
  assert.deepEqual(presentNames('has a', ['a', 'b']), ['a']);
  // Built by concatenation for the same reason the needles are: this file is
  // one of the files the scan reads.
  const needle = 'cloud' + 'flare';
  assert.deepEqual(providerHits({ f: `runs on ${'Cloud' + 'Flare'}` }, [needle]), [`f: ${needle}`]);
  assert.deepEqual(providerHits({ f: 'runs on its own' }, [needle]), []);

  assert.deepEqual(mockRouteMarkers("get(`${ADMIN}/nope`)"), ["'GET /nope'"]);
  assert.deepEqual(mockRouteMarkers("function runJob(a) {\n}\nget(`${ADMIN}/x`)"), ["'GET /x'"]);
  assert.deepEqual(mockRouteMarkers("request('POST', `${ADMIN}/x/${id}/burn`)"), ['/burn$']);
  assert.deepEqual(missingMockRoutes("get(`${ADMIN}/nope`)", '// an empty mock'), ["'GET /nope'"]);
  assert.deepEqual(missingMockRoutes("get(`${ADMIN}/nope`)", "'GET /nope': () => ({})"), []);
});

test('the tag scanner survives quoted angle brackets and entities', () => {
  const scanned = tags('<p title="a > b">&lt;not a tag&gt;</p><br>');
  assert.deepEqual(scanned.map((t) => t.name), ['p', 'br']);
  assert.equal(attr(scanned[0].attrs, 'title'), 'a > b');
});
