#!/usr/bin/env node
// `npm test`: the plugin suite, in a temp folder of its own that must be empty
// when the suite ends. Every test removes what it creates (`scratch` in
// fake.mjs, or its own `t.after`): the suite's leftovers once filled the
// machine it ran on, a million folders and 573 GiB. A run that leaves anything
// fails with one line naming what it left, and the folder goes either way.
// Arguments are passed to `node --test` ahead of the files.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const files = readdirSync(new URL(".", import.meta.url))
  .filter((name) => name.endsWith(".test.mjs"))
  .sort()
  .map((name) => join("test", name));
const folder = mkdtempSync(join(tmpdir(), "obsync-suite-"));
const env = { ...process.env, TMPDIR: folder, TMP: folder, TEMP: folder };
const run = spawnSync(process.execPath, ["--test", ...process.argv.slice(2), ...files], { stdio: "inherit", env });
// Node's own module compile cache lives in the temp folder; it is the runtime's, no test's.
const left = readdirSync(folder).filter((name) => name !== "node-compile-cache").sort();
rmSync(folder, { recursive: true, force: true });
if (left.length > 0) {
  console.error(`suite decision=refused reason=fixtures_left count=${left.length} left=${left.slice(0, 10).join(",")}`);
  process.exit(1);
}
process.exit(run.status ?? 1);
