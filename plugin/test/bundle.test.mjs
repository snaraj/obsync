/**
 * The artifact itself: `dist/main.js` is what Obsidian loads, so it is tested
 * as Obsidian loads it — required as CommonJS with `obsidian` resolved to a
 * stub, expecting the Plugin subclass as the default export.
 *
 * Also pinned here: the bundle is deterministic (the release evidence
 * manifest names its SHA-256), it carries no path from the build machine
 * (AGENTS.md requirement 11), and it names no ingress or access provider
 * (the provider-neutrality contract).
 */

import { strict as assert } from "node:assert";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { sandbox } from "./fake.mjs";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const plugin = join(dirname(fileURLToPath(import.meta.url)), "..");
const RELEASE_URL_PREFIX = "https://github.com/snaraj/obsync/releases/tag/v";

function build() {
  return execFileSync(process.execPath, ["build.mjs"], { cwd: plugin, encoding: "utf8" });
}

test("the bundler produces the same bytes every time", () => {
  const first = build();
  const one = readFileSync(join(plugin, "dist", "main.js"));
  const second = build();
  const two = readFileSync(join(plugin, "dist", "main.js"));
  assert.equal(createHash("sha256").update(one).digest("hex"), createHash("sha256").update(two).digest("hex"));
  assert.equal(first, second, "the reported hashes are stable too");
  assert.match(first, /main\.js bytes=\d+ sha256=[0-9a-f]{64}/);
  assert.match(first, /manifest\.json bytes=\d+ sha256=[0-9a-f]{64}/);
  assert.match(first, /styles\.css bytes=\d+ sha256=[0-9a-f]{64}/);
});

test("Obsidian's load path finds the plugin class as the default export", () => {
  build();
  const box = sandbox({ dist: true });
  const exported = box.require(join(box.home, "plugin", "main.js"));
  assert.equal(typeof exported, "function", "the bundle exports a class");
  assert.equal(typeof exported.prototype.onload, "function");
  assert.equal(typeof exported.prototype.onunload, "function");
  assert.equal(typeof exported.prototype.statusText, "function");
  const obsidian = box.require("obsidian");
  assert.ok(exported.prototype instanceof obsidian.Component, "it extends Obsidian's Plugin");
});

test("the bundle carries the whole plugin and nothing from the build machine", () => {
  build();
  const bundle = readFileSync(join(plugin, "dist", "main.js"), "utf8");
  for (const id of [
    "./main",
    "./crypto",
    "./chunker",
    "./state",
    "./transport",
    "./policy",
    "./pairing",
    "./wordlist",
    "./sync/engine",
    "./sync/push",
    "./sync/pull",
    "./sync/conflict",
    "./ui/settings",
    "./ui/modals",
    "./vaultPath",
  ]) {
    assert.ok(bundle.includes(`__modules[${JSON.stringify(id)}]`), `${id} is in the bundle`);
  }
  assert.ok(bundle.trimEnd().endsWith('module.exports = __load("./main").default;'));
  // Look for ABSOLUTE paths, not for the build directory's name: the plugin
  // is built at `/src` inside the CI image, and the bundle legitimately
  // documents `plugin/src`, so a substring test on the build path reports a
  // leak that is not one. A path only leaks if it appears as an absolute
  // path, which is what this matches.
  const leaked = bundle.match(
    /(?:^|[\s"`(=,;:])\/(?:Users|home|root|private|var|tmp|src|opt|mnt|data)\/[A-Za-z0-9._/-]+/g,
  );
  assert.deepEqual(leaked, null, `an absolute build path leaked into the artifact: ${leaked}`);
  // The ONE external URL the bundle may carry is the project's own GitHub
  // Release, and it is displayed, never fetched: v0.1 has no self-update
  // (docs/architecture.md 6.3), so the only host this code contacts is the
  // server the user configured. Every other URL still fails here.
  for (const url of bundle.match(/https?:\/\/[^\s"'`)]*/g) ?? []) {
    const allowed =
      url === "https://" || url.includes("example.") || url.startsWith(RELEASE_URL_PREFIX);
    assert.ok(allowed, `the bundle reaches for ${url}`);
  }
});

test("the shipped bundle has no path that installs code served by the server", () => {
  build();
  const bundle = readFileSync(join(plugin, "dist", "main.js"), "utf8");
  for (const marker of ["/v1/plugin/bundle", "/v1/plugin/styles", "installUpdate", "configDir"]) {
    assert.equal(bundle.includes(marker), false, `the bundle still carries ${marker}`);
  }
  assert.ok(bundle.includes(RELEASE_URL_PREFIX), "it points at the Release instead");
});

test("no ingress, tunnel or access provider is named in the shipped code", () => {
  const bundle = readFileSync(join(plugin, "dist", "main.js"), "utf8").toLowerCase();
  for (const provider of ["cloudflare", "cf-access", "tailscale", "ngrok", "fastly", "akamai", "route53"]) {
    assert.equal(bundle.includes(provider), false, `the bundle names ${provider}`);
  }
});

test("the manifest ships the values Obsidian and the release path expect", () => {
  const manifest = JSON.parse(readFileSync(join(plugin, "dist", "manifest.json"), "utf8"));
  assert.equal(manifest.id, "obsync");
  assert.equal(manifest.version, "0.1.0");
  assert.equal(manifest.isDesktopOnly, false, "the plugin runs on mobile");
  assert.ok(manifest.minAppVersion);
  const styles = readFileSync(join(plugin, "dist", "styles.css"), "utf8");
  assert.ok(styles.includes(".obsync-code"));
});

test("version comparison only offers a genuine upgrade", () => {
  build();
  const box = sandbox();
  const { isNewer } = box.require(join(box.home, "build", "main.js"));
  assert.equal(isNewer("0.1.1", "0.1.0"), true);
  assert.equal(isNewer("0.2.0", "0.1.9"), true);
  assert.equal(isNewer("1.0.0", "0.9.9"), true);
  assert.equal(isNewer("0.1.0", "0.1.0"), false);
  assert.equal(isNewer("0.0.9", "0.1.0"), false);
  assert.equal(isNewer("banana", "0.1.0"), false);
  assert.equal(isNewer("0.1.10", "0.1.9"), true);
});
