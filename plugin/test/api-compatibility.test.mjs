import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const plugin = join(dirname(fileURLToPath(import.meta.url)), "..");

test("the declared minimum uses the unmodified official API baseline", () => {
  const vendor = join(plugin, "vendor", "obsidian");
  const version = readFileSync(join(vendor, "VERSION"), "utf8").trim();
  const manifest = JSON.parse(readFileSync(join(plugin, "..", "manifest.json"), "utf8"));
  assert.equal(version, "1.12.3");
  assert.equal(manifest.minAppVersion, "1.12.4");
  assert.equal(createHash("sha256").update(readFileSync(join(vendor, "obsidian.d.ts"))).digest("hex"),
    "8dc0a334e2e927b7512f9d21be2a8d1934128cc7d3e2ce7d48164fe951f9e81e");
  assert.equal(createHash("sha256").update(readFileSync(join(vendor, "LICENSE.md"))).digest("hex"),
    "c7e9eeb6640ebb1c22d8888f6d2c771b1f058a54e6216d69c7e2224b3cbad394");
});

test("the real compiler accepts native secret get/set and rejects an undeclared operation", (t) => {
  const scratch = mkdtempSync(join(tmpdir(), "obsync-api-compatibility-"));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const fixture = join(scratch, "fixture.ts");
  const config = join(scratch, "tsconfig.json");
  writeFileSync(config, JSON.stringify({
    extends: join(plugin, "tsconfig.json"),
    compilerOptions: { rootDir: scratch, noEmit: true },
    include: [],
    files: [fixture],
  }));
  function compile(source) {
    writeFileSync(fixture, source);
    const result = spawnSync(process.execPath,
      [join(plugin, "node_modules", "typescript", "bin", "tsc"), "-p", config, "--pretty", "false"],
      { encoding: "utf8", timeout: 30_000 });
    assert.equal(result.error, undefined, "the compiler must actually run");
    assert.equal(result.signal, null, "a killed compiler is not an API refusal");
    return { status: result.status, output: result.stdout + result.stderr };
  }
  const supported = compile(`import { Plugin, TFile } from "obsidian";
declare const plugin: Plugin;
declare const file: TFile;
const contents: Promise<string> = plugin.app.vault.read(file);
const secret: string | null = plugin.app.secretStorage.getSecret("obsync-test");
plugin.app.secretStorage.setSecret("obsync-test", "fixture");
void contents;
void secret;
`);
  assert.equal(supported.status, 0, supported.output);
  const newer = compile('import { App } from "obsidian";\ndeclare const app: App;\napp.secretStorage.deleteSecret("obsync-test");\n');
  assert.equal(newer.status, 2, newer.output);
  assert.match(newer.output, /error TS2339: Property 'deleteSecret' does not exist on type 'SecretStorage'\./);
  assert.equal(newer.output.match(/error TS\d+:/g)?.length, 1, newer.output);
});
