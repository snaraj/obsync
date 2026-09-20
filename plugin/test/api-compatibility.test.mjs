import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const plugin = join(dirname(fileURLToPath(import.meta.url)), "..");
const DECLARATION = "./vendor/obsidian/node_modules/obsidian/obsidian.d.ts";

test("the declared minimum IS the vendored API baseline, unmodified", () => {
  // The declaration is pinned at exactly the floor so the compiler knows no
  // member the floor lacks; the two move together or not at all.
  const vendor = join(plugin, "vendor", "obsidian");
  const version = readFileSync(join(vendor, "VERSION"), "utf8").trim();
  const manifest = JSON.parse(readFileSync(join(plugin, "..", "manifest.json"), "utf8"));
  assert.equal(version, "1.13.0");
  assert.equal(manifest.minAppVersion, version);
  assert.equal(createHash("sha256").update(readFileSync(join(plugin, DECLARATION))).digest("hex"),
    "13827948460423b67bdd551091c516f25b72f19c3c9042dd774528dc0d37b965");
  assert.equal(createHash("sha256").update(readFileSync(join(vendor, "node_modules", "obsidian", "LICENSE.md"))).digest("hex"),
    "c7e9eeb6640ebb1c22d8888f6d2c771b1f058a54e6216d69c7e2224b3cbad394");
  // And the compiler resolves `obsidian` to that file and nothing else.
  const tsconfig = JSON.parse(readFileSync(join(plugin, "tsconfig.json"), "utf8"));
  assert.deepEqual(tsconfig.compilerOptions.paths.obsidian, [DECLARATION]);
});

test("the real compiler accepts what the floor declares and rejects what the next release added", (t) => {
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
  const supported = compile(`import { ButtonComponent, Plugin, PluginSettingTab, TFile } from "obsidian";
declare const plugin: Plugin;
declare const file: TFile;
declare const tab: PluginSettingTab;
declare const button: ButtonComponent;
const contents: Promise<string> = plugin.app.vault.read(file);
const secret: string | null = plugin.app.secretStorage.getSecret("obsync-test");
plugin.app.secretStorage.setSecret("obsync-test", "fixture");
const definitions = tab.getSettingDefinitions();
tab.update();
button.setDestructive();
void contents;
void secret;
void definitions;
`);
  assert.equal(supported.status, 0, supported.output);
  // 1.13.1 added `displayValue` to a settings page; 1.13.0 has no such member.
  const newer = compile('import { SettingDefinitionPage } from "obsidian";\nconst page: SettingDefinitionPage = { type: "page", name: "fixture", displayValue: "x" };\nvoid page;\n');
  assert.equal(newer.status, 2, newer.output);
  assert.match(newer.output, /error TS2353: Object literal may only specify known properties, and 'displayValue' does not exist in type 'SettingDefinitionPage<string>'\./);
  assert.equal(newer.output.match(/error TS\d+:/g)?.length, 1, newer.output);
  // SecretStorage has never declared a delete; the plugin must not assume one.
  const undeclared = compile('import { App } from "obsidian";\ndeclare const app: App;\napp.secretStorage.deleteSecret("obsync-test");\n');
  assert.equal(undeclared.status, 2, undeclared.output);
  assert.match(undeclared.output, /error TS2339: Property 'deleteSecret' does not exist on type 'SecretStorage'\./);
  assert.equal(undeclared.output.match(/error TS\d+:/g)?.length, 1, undeclared.output);
});
