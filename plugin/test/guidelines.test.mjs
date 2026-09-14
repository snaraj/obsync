/**
 * Obsidian's published plugin guidelines, as rules over `plugin/src`.
 *
 * The directory's reviewers apply these to the source, and the official
 * `eslint-plugin-obsidianmd` encodes them as lint rules. This repository ships
 * exactly one devDependency -- the TypeScript compiler (requirement 5) -- so
 * the rules that are decidable by reading the source are decided here instead,
 * the same way `dashboard/test/html.test.mjs` decides the dashboard's.
 *
 * What is NOT here is everything that needs judgement rather than a pattern:
 * sentence case in UI strings, whether a heading is warranted, whether a
 * command name reads as a command. Those are audited in review and recorded in
 * the pull request; a pattern that pretended to decide them would be a pattern
 * nobody trusts.
 */

import { strict as assert } from "node:assert";
import test from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PLUGIN = dirname(dirname(fileURLToPath(import.meta.url)));
const SRC = join(PLUGIN, "src");

function sources(dir = SRC, found = {}) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) sources(full, found);
    else if (entry.name.endsWith(".ts")) found[full.slice(SRC.length + 1)] = readFileSync(full, "utf8");
  }
  return found;
}

/** Each rule: the guideline it comes from, and the shape that breaks it. */
const RULES = [
  // DOM from a string is the one that turns vault content into markup.
  ["no innerHTML/outerHTML/insertAdjacentHTML", /\b(inner|outer)HTML\b|insertAdjacentHTML/],
  // Obsidian's desktop app is Electron: the bare globals are Node's and hand
  // back a `Timeout` object where every Obsidian surface expects a number.
  ["window timers, never the bare globals", /(^|[^.\w$])(set|clear)(Timeout|Interval)\s*\(/m],
  // `Platform` is the API; sniffing the user agent gets Electron's, not the
  // platform Obsidian is actually running as.
  ["Platform, never navigator sniffing", /navigator\s*\.\s*(platform|userAgent|appVersion)\b/],
  // iOS's regex engine has no lookbehind, so a lookbehind is a crash on one
  // of the platforms requirement 14 names.
  ["no regex lookbehind (iOS)", /\(\?<[=!]/],
  // The global `app` is deprecated and is not this vault's App in every
  // context; `this.app` is.
  ["this.app, never the global app", /(^|[^.\w$])app\s*\.\s*(vault|workspace|fileManager|metadataCache)\b/m],
];

function violations(files) {
  const found = [];
  for (const [name, source] of Object.entries(files)) {
    for (const [rule, pattern] of RULES) {
      const match = pattern.exec(source);
      if (match) {
        const line = source.slice(0, match.index).split("\n").length;
        found.push(`${name}:${line}: ${rule} (${match[0].trim()})`);
      }
    }
  }
  return found;
}

test("plugin/src holds every guideline rule a pattern can decide", () => {
  const files = sources();
  assert.ok(Object.keys(files).length >= 15, `the walk found the sources (${Object.keys(files).length})`);
  assert.deepEqual(violations(files), []);
});

test("each rule catches the shape it names, and leaves the correct one alone", () => {
  // A rule no input can fail is decoration standing next to real rules.
  const caught = (source) => violations({ "probe.ts": source });
  assert.equal(caught("el.innerHTML = value;").length, 1);
  assert.equal(caught("el.outerHTML = value;").length, 1);
  assert.equal(caught("el.insertAdjacentHTML('beforeend', value);").length, 1);
  assert.equal(caught("setTimeout(fn, 5);").length, 1);
  assert.equal(caught("const id = setInterval(fn, 5);").length, 1);
  assert.equal(caught("clearTimeout(handle);").length, 1);
  assert.equal(caught("if (navigator.platform === 'iPhone') return;").length, 1);
  assert.equal(caught("const re = /(?<=a)b/;").length, 1);
  assert.equal(caught("const file = app.vault.getFileByPath(path);").length, 1);

  assert.deepEqual(caught("el.setText(value);"), []);
  assert.deepEqual(caught("window.setTimeout(fn, 5);"), []);
  assert.deepEqual(caught("window.clearTimeout(handle);"), []);
  assert.deepEqual(caught("if (Platform.isIosApp) return;"), []);
  assert.deepEqual(caught("const file = this.app.vault.getFileByPath(path);"), []);
  assert.deepEqual(caught("const file = plugin.app.vault.getFileByPath(path);"), []);
});

test("the shipped manifest keeps the mobile promise requirement 14 makes", () => {
  const manifest = JSON.parse(readFileSync(join(dirname(PLUGIN), "manifest.json"), "utf8"));
  assert.equal(manifest.isDesktopOnly, false, "the plugin runs on every Obsidian platform");
  assert.equal(manifest.id, "obsync-private-sync", "the directory identity");
  for (const field of ["name", "version", "minAppVersion", "description", "author", "authorUrl"]) {
    assert.equal(typeof manifest[field], "string", `the directory requires ${field}`);
  }
});
