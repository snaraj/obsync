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
  assert.equal(version, "1.7.2");
  assert.equal(manifest.minAppVersion, version);
  assert.equal(createHash("sha256").update(readFileSync(join(vendor, "obsidian.d.ts"))).digest("hex"),
    "422eb0b21da5c69aef689cbfc643f2b953b5b31537328e01022490a3944b5830");
});

test("the real compiler accepts supported APIs and rejects a newer runtime API", (t) => {
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
void contents;
`);
  assert.equal(supported.status, 0, supported.output);
  // BooleanValue was added in Obsidian 1.10. A real import proves that an
  // accidental return to newer declarations cannot hide behind skipLibCheck.
  const newer = compile('import { BooleanValue } from "obsidian";\nvoid BooleanValue;\n');
  assert.equal(newer.status, 2, newer.output);
  assert.match(newer.output, /error TS2305: Module '"obsidian"' has no exported member 'BooleanValue'\./);
  assert.equal(newer.output.match(/error TS\d+:/g)?.length, 1, newer.output);
});
